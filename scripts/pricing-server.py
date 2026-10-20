#!/usr/bin/env python3
"""Loopback reference adapter for the proposed public pricing HTTP contract.

Development only. No auth, storage, source fetching, or production deployment.
Install metergraph-core==0.5.0 in an isolated environment before running.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
import json
import re
from urllib.parse import parse_qs, urlsplit

from metergraph_core import ModelUsage, load_catalog, parse_catalog

SCHEMA = "metergraph.pricing/v1"
TOKENS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens")
RATE_KEYS = ("input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_5m_per_mtok", "cache_write_1h_per_mtok", "batch_input_per_mtok", "batch_output_per_mtok")


def iso(v):
    return v.isoformat().replace("+00:00", "Z") if v is not None else None


def price(p):
    if p is None:
        return None
    return dict(id=p.id, model_id=p.model_id, channel=p.pricing_channel, region=p.region,
                currency=p.currency, effective_from=iso(p.effective_from), effective_to=iso(p.effective_to),
                source_url=p.source_url, rules=dict(p.rules),
                request_fee_per_1k=format(p.request_fee_per_1k_usd, "f") if p.request_fee_per_1k_usd is not None else None,
                **{k: format(getattr(p, k), "f") if getattr(p, k) is not None else None for k in RATE_KEYS})


def request(action, pairs):
    selectors = {"model", "provider", "channel", "region"}
    allowed = selectors | {"at"}
    if action == "cost":
        allowed |= set(TOKENS) | {"batch"}
    if action == "market":
        allowed = {"channel", "region", "at", "limit"}
    if set(pairs) - allowed or any(len(v) != 1 for v in pairs.values()):
        raise ValueError()
    q = {k: v[0] for k, v in pairs.items()}
    for k in selectors & q.keys():
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}", q[k]):
            raise ValueError()
    if "at" not in q or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", q["at"]):
        raise ValueError()
    datetime.strptime(q["at"], "%Y-%m-%d")
    if action != "market" and not q.get("model"):
        raise ValueError()
    if q.get("channel") and q.get("provider"):
        raise ValueError()
    if action in ("market", "history") and (not q.get("channel") or not q.get("region")):
        raise ValueError()
    for k in set(TOKENS) & q.keys():
        if not re.fullmatch(r"0|[1-9]\d{0,11}", q[k]):
            raise ValueError()
        q[k] = int(q[k])
    if "batch" in q:
        if q["batch"] != "true":
            raise ValueError()
        q["batch"] = True
    if "cache_write_tokens" in q and any(k in q for k in ("cache_write_5m_tokens", "cache_write_1h_tokens")):
        raise ValueError()
    if action == "market":
        if not re.fullmatch(r"[1-9]\d?|100", q.get("limit", "")):
            raise ValueError()
        q["limit"] = int(q["limit"])
    return q


class Pricing:
    def __init__(self, catalog):
        self.catalog = catalog
        # Public parser; never depend on the snapshot's private indexes.
        _, _, self.rows = parse_catalog(catalog.document)

    def respond(self, action, q):
        c = self.catalog
        at = datetime.strptime(q["at"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        args = {k: v for k, v in q.items() if k in ("model", "provider", "channel", "region")}
        if action in ("lookup", "cost"):
            if action == "lookup":
                found = c.lookup_price(at=at, **args)
            else:
                usage = ModelUsage(**{k: v for k, v in q.items() if k in (*TOKENS, "batch")})
                found = c.calculate_cost(at=at, usage=usage, **args)
            result = dict(status=found.status, model_id=found.model_id, price=price(found.price),
                          effective_at=iso(found.effective_at), missing_dimensions=list(found.missing_dimensions))
            if action == "cost":
                result.update(cost=format(found.cost, "f") if found.cost is not None else None,
                              currency=found.currency, reasons=list(found.reasons),
                              components={k: format(getattr(found.components, k), "f") for k in ("input", "output", "cache_read", "cache_write", "request")} if found.components else None)
        else:
            canonical = None
            if action == "history":
                # Resolve aliases at the requested date, never cross a channel.
                canonical = c.lookup_price(at=at, **args).model_id
                # Canonical identifiers may have ended before the requested date.
                if canonical is None and any(p.model_id == q["model"] for p in self.rows):
                    canonical = q["model"]
            groups = {}
            for p in self.rows:
                if p.pricing_channel != q["channel"] or p.region != q["region"] or p.effective_from > at:
                    continue
                if action == "history" and p.model_id != canonical:
                    continue
                groups.setdefault((p.model_id, p.currency), []).append(p)
            series = []
            for (model, currency), points in groups.items():
                points.sort(key=lambda p: p.effective_from)
                if len(points) > 1000:
                    raise ValueError()
                # A market board shows active prices only; history retains ended windows.
                if action == "market" and points[-1].effective_to is not None and points[-1].effective_to <= at:
                    continue
                series.append(dict(model_id=model, channel=q["channel"], region=q["region"], currency=currency,
                                   points=[price(p) for p in points]))
            series.sort(key=lambda s: (s["points"][-1]["effective_from"], s["model_id"]), reverse=True)
            limit = q.get("limit", 1)
            result = dict(series=series[:limit], matched=len(series), truncated=len(series) > limit)
        return dict(schema_version=SCHEMA, action=action, request=q, result=result,
                    catalog=dict(version=c.version, content_hash=c.content_hash,
                                 pricing_verified_at=c.pricing_verified_at.isoformat(),
                                 served_at=iso(datetime.now(timezone.utc)), core_version=version("metergraph-core")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--catalog", help="Optional local catalog path; defaults to core's bundled catalog")
    options = parser.parse_args()
    pricing = Pricing(load_catalog(path=options.catalog))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path)
            action = path.path.removeprefix("/v1/pricing/")
            status, data = 200, None
            if not path.path.startswith("/v1/pricing/") or action not in ("lookup", "cost", "history", "market"):
                status, data = 404, {"error": "not_found"}
            else:
                try:
                    if len(self.path) > 4096:
                        raise ValueError()
                    q = request(action, parse_qs(path.query, keep_blank_values=True, max_num_fields=20))
                    data = pricing.respond(action, q)
                except (ValueError, TypeError):
                    status, data = 400, {"error": "invalid_pricing_request"}
            body = json.dumps(data, default=lambda v: str(v) if isinstance(v, Decimal) else dict(v), allow_nan=False).encode()
            if len(body) > 1024 * 1024:
                status, body = 413, b'{"error":"response_too_large"}'
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    print(f"Reference pricing adapter: http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

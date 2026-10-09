# One instrumented application call for parity runs. The OpenAI client points
# at the harness's local mock, so no provider is called and nothing is billed.
# The Metergraph SDK reads METERGRAPH_APP_TOKEN and METERGRAPH_INGEST_URL from
# the environment, which the harness loads from the env file setup wrote.
# Usage: python sdk_app.py TRACE_ID MOCK_BASE_URL
import json
import sys

import metergraph
from openai import OpenAI

trace_id, mock_base_url = sys.argv[1], sys.argv[2]
client = metergraph.wrap(OpenAI(base_url=mock_base_url, api_key="parity-mock"))
with metergraph.trace("cli-parity", trace_id=trace_id), metergraph.route("cli-parity-check"):
    client.chat.completions.create(
        model="parity-mock-model",
        messages=[{"role": "user", "content": "parity check"}],
        max_completion_tokens=8,
    )
print(json.dumps({"flushed": metergraph.flush(10.0)}))

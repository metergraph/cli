// Preloaded with --import to prove a command makes no network or DNS calls.
// Any attempt fails the process loudly with a fixed exit code.
import dns from "node:dns";
import net from "node:net";

const blocked = () => {
  process.stderr.write("NETWORK_ACCESS_ATTEMPTED\n");
  process.exit(99);
};

net.Socket.prototype.connect = blocked;
dns.lookup = blocked;
dns.resolve = blocked;
dns.promises.lookup = blocked;

"""Exercise deploy/finalize/verify against a fresh local Anvil, with no private keys.

Run from any directory with forge and anvil on PATH. All output documents are under
contracts/test/script/tmp; the checked-in deployment records are never changed.
"""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"


def main():
    forge = shutil.which("forge")
    anvil = shutil.which("anvil")
    if not forge or not anvil:
        raise SystemExit("forge and anvil must be on PATH")
    run = CONTRACTS / "test/script/tmp" / ("live-" + uuid.uuid4().hex)
    run.mkdir(parents=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"

    def rpc(method, params):
        request = urllib.request.Request(url, json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        }).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["result"]

    def write(path, data):
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")

    env = os.environ.copy()
    env["LUCKYDRAW_DEPLOYMENTS_DIR"] = (run / "deployments").as_posix()
    # These overrides belong to the local mock fixture only; ignore any caller customization.
    for key in ("LUCKYDRAW_LOCAL_FINAL_OWNER", "LUCKYDRAW_LOCAL_FEE_ACCOUNT", "LUCKYDRAW_LOCAL_SEED_ACCOUNT"):
        env.pop(key, None)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with (run / "anvil.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([anvil, "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent"],
                                   stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            for _ in range(100):
                try:
                    assert rpc("eth_chainId", []) == "0x7a69"
                    break
                except (OSError, AssertionError):
                    if process.poll() is not None:
                        raise RuntimeError("Anvil exited before startup")
                    time.sleep(0.1)
            else:
                raise RuntimeError("Anvil did not start")

            def script(name, label, *args, failure=None):
                result = subprocess.run([forge, "script", f"script/{name}.s.sol:{name}", "--rpc-url", url,
                                         *args], cwd=CONTRACTS, env=env, capture_output=True, text=True, encoding="utf-8",
                                        creationflags=flags)
                output = result.stdout + result.stderr
                (run / f"{label}.log").write_text(output, encoding="utf-8")
                if failure is None:
                    if result.returncode:
                        raise RuntimeError(f"{label} failed:\n{output[-4000:]}")
                elif result.returncode == 0 or failure not in output:
                    raise RuntimeError(f"{label} did not reject with {failure!r}:\n{output[-4000:]}")
                print(f"PASS {label}", flush=True)

            script("DeployLocal", "deploy", "--broadcast", "--unlocked", "--sender",
                   "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")
            manifest = next((run / "deployments/31337").glob("0x*.json"))
            env["LUCKYDRAW_MANIFEST"] = manifest.as_posix()
            broadcast = CONTRACTS / "broadcast/DeployLocal.s.sol/31337/run-latest.json"
            env["LUCKYDRAW_BROADCAST"] = broadcast.as_posix()
            script("Verify", "reject-unfinalized", failure="History: missing deployTx")
            script("Finalize", "finalize")
            original = json.loads(manifest.read_text(encoding="utf-8"))
            for record in original["contracts"].values():
                receipt = rpc("eth_getTransactionReceipt", [record["deployTx"]])
                assert int(receipt["blockNumber"], 16) == record["deployBlock"]
                assert receipt["contractAddress"].lower() == record["address"]
            script("Verify", "verify-canonical")
            rpc("evm_mine", [])
            tampered = json.loads(json.dumps(original))
            later = int(rpc("eth_blockNumber", []), 16)
            tampered["chain"]["startBlock"] = later
            for record in tampered["contracts"].values():
                record["deployBlock"] = later
            write(manifest, tampered)
            script("Verify", "reject-late-history", failure="check(s) failed")
            tampered = json.loads(json.dumps(original))
            tampered["contracts"]["vault"]["deployTx"] = "0x" + "ab" * 32
            write(manifest, tampered)
            script("Verify", "reject-invented-receipt", failure="History: deployment receipt not found")
            write(manifest, original)
            node = shutil.which("node")
            subprocess.run([node, str(ROOT / "scripts/validate_config.ts"), str(run)], check=True,
                           cwd=ROOT, env=env, creationflags=flags, stdout=subprocess.DEVNULL)
            print(f"PASS live deployment regression; logs: {run}", flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()

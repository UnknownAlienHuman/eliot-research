from pathlib import Path

path = Path("apps/eliotr-core/src/external-agent-result-wake.ts")
text = path.read_text(encoding="utf-8")
old = "interface ExternalAgentResultReceipt {\n"
new = "interface ExternalAgentResultReceipt {\n  readonly [key: string]: unknown;\n"
if text.count(old) != 1:
    raise SystemExit(f"expected one ExternalAgentResultReceipt interface, found {text.count(old)}")
path.write_text(text.replace(old, new), encoding="utf-8")

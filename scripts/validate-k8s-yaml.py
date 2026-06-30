#!/usr/bin/env python3
import pathlib
import sys

try:
    import yaml
except ImportError:
    print("PyYAML required: pip install pyyaml")
    sys.exit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
K8S = ROOT / "k8s"

errors = []
total = 0

for path in sorted(K8S.rglob("*.yaml")):
    if "example" in path.name:
        continue
    try:
        docs = list(yaml.safe_load_all(path.read_text()))
        if not any(d is not None for d in docs):
            errors.append(f"{path}: empty document")
        else:
            total += sum(1 for d in docs if d is not None)
            print(f"  OK: {path.relative_to(ROOT)} ({sum(1 for d in docs if d is not None)} docs)")
    except yaml.YAMLError as exc:
        errors.append(f"{path}: {exc}")

if errors:
    print("\nValidation failed:")
    for err in errors:
        print(f"  - {err}")
    sys.exit(1)

print(f"\nValidated {total} Kubernetes documents across {K8S}")

#!/usr/bin/env python3
"""Rebuild GraphRAG store by re-ingesting all documents."""
import json
import os
import subprocess
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOCS_DIR = os.path.join(BASE_DIR, "docs", "graphrag-test")
GRAPHRAG_URL = "http://localhost:8001"

FILES = {
    "semaa-policy-001": "01_marine_policy.txt",
    "semaa-incident-003": "02_incident_report.txt",
    "semaa-contract-088": "03_supplier_contract.txt",
    "semaa-portlog-014": "04_port_maintenance_log.txt",
    "semaa-training-q1": "05_crew_training_record.txt",
    "semaa-budget-h1": "06_budget_and_procurement_plan.txt",
}

def get_token():
    result = subprocess.check_output([
        "docker", "exec", "graphrag_api", "node", "-e",
        'const jwt=require("jsonwebtoken"); '
        'console.log(jwt.sign({sub:"rebuild"}, process.env.JWT_SECRET, {expiresIn:"1h"}));'
    ])
    return result.decode().strip()

def ingest(file_id, filename, text, token):
    payload = json.dumps({"file_id": file_id, "filename": filename, "text": text}).encode()
    req = urllib.request.Request(
        f"{GRAPHRAG_URL}/ingest-text",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def main():
    print("GraphRAG Store Rebuild")
    print("=" * 40)
    token = get_token()
    for file_id, filename in FILES.items():
        path = os.path.join(DOCS_DIR, filename)
        if not os.path.exists(path):
            print(f"  SKIP {filename} — not found")
            continue
        with open(path, encoding="utf-8") as f:
            text = f.read()
        result = ingest(file_id, filename, text, token)
        print(f"  {filename}: chunks={result.get('chunk_count')}, entities={result.get('entity_count')}, ok={result.get('status')}")
    print("=" * 40)
    print("Done.")

if __name__ == "__main__":
    main()

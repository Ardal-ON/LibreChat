# SEMAA GraphRAG Demo Conversation Script
**Purpose:** Demonstrate GraphRAG document management and cross-document query capability.  
**Steps:** List → Delete → Add → Ingest → Cross-doc query on new doc → Confirm deleted doc is gone.

---

## Step 1 — List all documents currently in the database

**User prompt:**
```
List all documents currently stored in the GraphRAG knowledge base.
```

**Expected agent behavior:**  
Agent calls `graphrag_list_documents`. Response should show 7 entries:

| file_id | filename |
|---------|----------|
| semaa-policy-001 | 01_marine_policy.txt |
| semaa-incident-003 | 02_incident_report.txt |
| semaa-contract-088 | 03_supplier_contract.txt |
| semaa-portlog-014 | 04_port_maintenance_log.txt |
| semaa-training-q1 | 05_crew_training_record.txt |
| semaa-budget-h1 | 06_budget_and_procurement_plan.txt |
| semaa-report-007 | 07_vessel_inspection_checklist.txt |

**Pass criterion:** All 7 documents are listed with correct IDs.

---

## Step 2 — Delete one document

**User prompt:**
```
Please delete the document with file_id "semaa-portlog-014" from the knowledge base.
```

**Expected agent behavior:**  
Agent calls `graphrag_delete_documents` with `file_id: "semaa-portlog-014"`. Confirmation message returned. Optionally, agent re-runs `graphrag_list_documents` to show 6 remaining documents.

**Pass criterion:** semaa-portlog-014 (port maintenance log) no longer appears in the document list.

---

## Step 3 — Upload the new document

*(This step is done by the user in the LibreChat file picker before the next prompt.)*

> **Action:** Upload `08_emergency_response_protocol.txt` via the paperclip / attachment button in the chat input.  
> The file will be staged and a file reference will appear in the message box.

---

## Step 4 — Ingest the new document

**User prompt:**
```
I just uploaded a file called "08_emergency_response_protocol.txt". 
Please ingest it into GraphRAG with file_id "semaa-erp-008".
```

**Expected agent behavior:**  
Agent calls `graphrag_ingest_uploaded_file` (or `graphrag_ingest_document`) with the uploaded file reference and assigns `file_id: "semaa-erp-008"`. After ingestion succeeds, agent calls `graphrag_list_documents` to confirm 7 documents (six originals minus port log, plus new ERP).

**Pass criterion:** semaa-erp-008 appears in the document list with filename `08_emergency_response_protocol.txt`.

---

## Step 5 — Cross-document query on the new document

### 5-A: ERP references training records

**User prompt:**
```
According to the emergency response protocol, which training modules must crew complete 
before being assigned emergency duties? Are those modules mentioned in any other document 
in the knowledge base?
```

**Expected answer:**  
- ERP Section 6 requires Module A (Engine Overheating Response) and Module C (Incident Communication Escalation) from the Q1 training program.  
- The crew training record (semaa-training-q1 / `05_crew_training_record.txt`) covers both modules — Module A is a core technical module and Module C covers escalation procedures.  
- Both documents reference Q1 coordinator Alice Chen.

**Pass criterion:** Agent cites both `semaa-erp-008` and `semaa-training-q1` as source documents.

---

### 5-B: ERP references supplier contract

**User prompt:**
```
The emergency response protocol mentions a supplier contract. 
Which specific contract does it reference, and what are the delivery terms?
```

**Expected answer:**  
- ERP Section 2 mentions OceanCore Parts Ltd. under contract SC-88 for CPF-9 cooling pump filter inventory.  
- The supplier contract document (semaa-contract-088 / `03_supplier_contract.txt`) is SC-88 with OceanCore Parts Ltd., which includes a 24-hour emergency delivery SLA.

**Pass criterion:** Agent links `semaa-erp-008` to `semaa-contract-088` and states the 24-hour SLA.

---

### 5-C: ERP references inspection checklist

**User prompt:**
```
The emergency response protocol refers to an inspection checklist for fire extinguisher 
locations. What is the document ID of that checklist, and does it confirm E-4 terminal 
slot placement?
```

**Expected answer:**  
- ERP Section 3 references checklist IC-2026-V1, which maps to `semaa-report-007` (`07_vessel_inspection_checklist.txt`).  
- The inspection checklist (semaa-report-007) includes an Electrical section that flags E-4 terminal slot as needing replacement per PM-2026-014 maintenance findings.

**Pass criterion:** Agent links `semaa-erp-008` → `semaa-report-007` → references to PM-2026-014.

---

## Step 6 — Confirm deleted document is no longer queryable

**User prompt:**
```
According to the port maintenance log, what repair work was completed in February 2026 
and which technician signed off on the E-4 terminal slot replacement?
```

**Expected agent behavior:**  
Agent calls `graphrag_query_knowledge`. Because `semaa-portlog-014` has been deleted, the knowledge graph no longer contains that document's content. The agent should respond that the information is not available or that no port maintenance log data exists in the current knowledge base. It should **not** cite PM-2026-014 details or technician names from the old log.

**Pass criterion:**  
- Agent does **not** return specific maintenance details from the deleted port log.  
- Agent explicitly states the document is not available or no matching records exist.  
- Optionally, agent notes the document was previously removed from the knowledge base.

---

## Summary Checklist

| # | Action | Pass Condition |
|---|--------|---------------|
| 1 | List documents | 7 docs shown, all IDs correct |
| 2 | Delete semaa-portlog-014 | No longer in list |
| 3 | Upload file | File attachment visible in chat |
| 4 | Ingest semaa-erp-008 | Appears in list, count = 7 |
| 5-A | ERP × training query | Cites semaa-erp-008 + semaa-training-q1 |
| 5-B | ERP × supplier contract | Cites semaa-erp-008 + semaa-contract-088, names 24h SLA |
| 5-C | ERP × inspection checklist | Links semaa-erp-008 → semaa-report-007 → PM-2026-014 |
| 6 | Deleted doc query | Returns "not available" — no detail from portlog |

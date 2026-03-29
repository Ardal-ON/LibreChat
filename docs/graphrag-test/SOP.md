# GraphRAG MCP 測試 SOP

## 0. 目的
確認以下能力完整可用：
1. MCP server 可用
2. 文件可寫入 GraphRAG 知識庫
3. 新聊天可跨對話檢索同一知識庫
4. 可刪除與重建知識庫（database）

## 1. 前置條件
1. 服務已啟動：api, rag_api, graphrag_api
2. MCP 清單可看到 graphrag / SEMAA GraphRAG
3. 本機測試資料已存在於 docs/graphrag-test

## 2. 建立或重置 GraphRAG database
執行：

sh scripts/graphrag/init_store.sh

驗證：

sh scripts/graphrag/check_store.sh

預期：
1. 檔案 graphrag_data/store.json 存在
2. 初始內容為 files 空物件

## 3. 匯入測試文件（Ingest）
請在 LibreChat 新聊天中，使用 graphrag MCP 工具呼叫以下三次：

Tool: graphrag_ingest_document

A.
- file_id: semaa-policy-001
- filename: 01_marine_policy.txt
- text: 請貼上 docs/graphrag-test/01_marine_policy.txt 全文

B.
- file_id: semaa-incident-003
- filename: 02_incident_report.txt
- text: 請貼上 docs/graphrag-test/02_incident_report.txt 全文

C.
- file_id: semaa-contract-088
- filename: 03_supplier_contract.txt
- text: 請貼上 docs/graphrag-test/03_supplier_contract.txt 全文

每次預期回傳：
1. status = ok
2. action = ingested
3. chunks > 0

## 3A. 使用「上傳檔案」直接建立 database（推薦）
若不想貼全文，請改用工具：graphrag_ingest_uploaded_file

步驟：
1. 先在聊天 UI 上傳 .md 或 .txt 檔案
2. 呼叫 graphrag_ingest_uploaded_file，傳入：
  - filename: 上傳檔名（例如 01_marine_policy.txt）
  - file_id: 建議給固定值（例如 semaa-policy-001）
3. 對三份檔案各做一次

預期：
1. action = ingested_uploaded_file
2. 回傳 uploaded_path 與 chunks
3. graphrag_list_documents 可看到三筆

## 4. 清單驗證
Tool: graphrag_list_documents

預期至少有 3 筆：
1. semaa-policy-001
2. semaa-incident-003
3. semaa-contract-088

## 5. 單輪檢索驗證
依序測 test_cases.json 的 TC01 到 TC08，使用 Tool: graphrag_query_knowledge

建議參數：
1. query: 該題問題文字
2. top_k: 5

通過標準：
1. 回答包含 expected_keywords 中至少 2 個關鍵詞
2. 回答內容與 source_file 指向一致

## 6. 跨新聊天持久化驗證（核心）
1. 開啟全新聊天（不要沿用前一個）
2. 直接呼叫 graphrag_query_knowledge，問 TC03 / TC08
3. 不重新 ingest

通過標準：
1. 仍可回答出正確資訊
2. 命中語意與關鍵詞與前一聊天一致

## 7. 刪除驗證
Tool: graphrag_delete_documents

輸入：
- file_ids:
  - semaa-contract-088

驗證：
1. graphrag_list_documents 不再出現 semaa-contract-088
2. 再問 TC05，預期答案降低或無法完整命中

## 8. 回歸重建
1. 重新 ingest semaa-contract-088
2. 再問 TC05
3. 預期恢復可正確命中 USD 220

## 9. 交付驗收標準
全部完成即通過：
1. MCP server 可見且可呼叫
2. Ingest / List / Query / Delete 均成功
3. 新聊天可查到舊資料（持久化成功）
4. 刪除後結果受影響、重建後恢復

## 10. 問題排查
A. MCP 清單沒看到 graphrag
1. 檢查正在跑的專案目錄是否正確
2. 檢查 /app/librechat.yaml 內容是否含 mcpServers.graphrag

B. Query 沒結果
1. 先跑 graphrag_list_documents
2. 確認資料已 ingest
3. top_k 提高到 8

C. 新聊天查不到舊資料
1. 檢查 graphrag_data/store.json 是否有內容
2. 檢查 volume 掛載是否正確

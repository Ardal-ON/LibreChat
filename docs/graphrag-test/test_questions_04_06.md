# GraphRAG Test Questions for Files 04-06

## Ingest IDs (suggested)
- 04_port_maintenance_log.txt -> semaa-portlog-014
- 05_crew_training_record.txt -> semaa-training-q1
- 06_budget_and_procurement_plan.txt -> semaa-budget-h1

## Questions
1. PM-2026-014 中，WO-7713 的開始與完成時間是什麼？
   - Expected keywords: 09:20, 10:40, WO-7713
   - Source: 04_port_maintenance_log.txt

2. 維修紀錄中，哪個 slot 發現端子鬆脫？
   - Expected keywords: E-4, loose terminal
   - Source: 04_port_maintenance_log.txt

3. 主管 Daniel Tsai 何時完成 final sign-off？
   - Expected keywords: 12:45, Daniel Tsai
   - Source: 04_port_maintenance_log.txt

4. TR-2026-Q1 中，Meridian-22 的 completion rate 與平均分數是多少？
   - Expected keywords: 89 percent, 84
   - Source: 05_crew_training_record.txt

5. 哪一艘船需要在 2026-03-05 前完成補訓？
   - Expected keywords: Meridian-22, remedial drill, 2026-03-05
   - Source: 05_crew_training_record.txt

6. 培訓規範中，低於多少 completion rate 需要 14 天內補訓？
   - Expected keywords: 90 percent, 14 days
   - Source: 05_crew_training_record.txt

7. BP-2026-H1 中，spare parts budget 金額是多少？
   - Expected keywords: USD 340,000, spare parts budget
   - Source: 06_budget_and_procurement_plan.txt

8. 單筆 PO 超過多少需要 dual approval？
   - Expected keywords: USD 50,000, dual approval
   - Source: 06_budget_and_procurement_plan.txt

9. 緊急預備金使用超過多少，需在幾小時內通知 Safety Director？
   - Expected keywords: USD 20,000, 12 hours
   - Source: 06_budget_and_procurement_plan.txt

10. 跨檔案問題：誰是 Q1 培訓 coordinator，且 budget plan 的財務負責人是誰？
    - Expected keywords: Alice Chen, Irene Kuo
    - Source: 05_crew_training_record.txt + 06_budget_and_procurement_plan.txt

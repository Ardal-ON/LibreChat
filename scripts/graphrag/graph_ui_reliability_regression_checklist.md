# GraphRAG 驗證腳本 + 回歸清單（可直接照跑）

目的：用同一份文件完成「實際對話驗證腳本」與「回歸打勾清單」。

驗證三層策略：

- 主通道：ui_resources 附件承載完整圖資料
- fallback：文字保留精簡摘要與 graph_id
- 重抓：附件缺失時，前端用 graph_id 呼叫 graphrag_get_graph_by_id 恢復 UI

## 1. 10 分鐘快跑流程

1. 啟動服務。
2. 在聊天送固定 prompt。
3. 驗證 Case A：主通道正常顯示圖。
4. 套用附件丟失模擬腳本。
5. 重新整理同一 conversation，驗證 Case B：有 graph_id 時會自動重抓並恢復圖。
6. 做摘要輸出模擬，驗證 Case C：仍可透過 cache 或 graph_id 恢復圖。
7. 依最下方清單逐項填 PASS/FAIL。

## 2. 前置條件

1. 後端可用：http://localhost:3080
2. 前端可開啟聊天頁面
3. GraphRAG MCP server 可用（例如 graphrag 或 semaa-graphrag-mcp）
4. 已有可查 KB 資料

可選的快速健康檢查：

```bash
cd /Users/deng/Library/Mobile\ Documents/com~apple~CloudDocs/Desktop/USC/Impact/SEMAA_Ardalan/LibreChat
node scripts/graphrag/full_feature_test.js
```

## 3. 固定測試 Prompt

請在聊天貼上以下文字：

```text
請用 graphrag_query_with_graph 查詢：Wicked Witch of the West 與 Dorothy 的衝突關係，top_k=8, max_nodes=80, include_results=true。
```

建議每輪回歸都維持：同一 conversation、同一 prompt、同一 top_k/max_nodes。

### OZ 自然語句測試題（默認偏向 with_graph）

以下 10 題都刻意寫成「關係、網路、路徑、連結、變化」導向，自然情況下應優先觸發 graphrag_query_with_graph，而不需要你手動加 with graph：

1. Show Dorothy's alliance network and highlight what evidence connects each ally to her.
2. Map the characters directly connected to Dorothy and label the kind of relationship each one has with her.
3. Trace how the Wizard's authority in Emerald City changes over time and show the key people or events connected to that shift.
4. Build a relationship graph around Dorothy that separates allies, advisors, companions, and opponents.
5. Show which characters or groups are opposed to Dorothy, and include the conflict links that connect them.
6. Map how the Wicked Witch of the West exercises power through other characters, creatures, or systems.
7. Show the relationship network linking the Wicked Witch of the East, the Wicked Witch of the West, and the Munchkins.
8. Build a graph of the most important magical artifacts in Oz and show which characters are connected to each one.
9. Trace Dorothy's journey along the Yellow Brick Road and show how it connects her to major allies, places, and turning points.
10. Show the strongest cross-document network around Emerald City, including characters, institutions, and major power transitions.

如果你要更穩定地偏向圖，可以把每題句尾再加上一句：

```text
Show the result as a relationship graph with labeled connections.
```

這樣仍是自然語句，但會更明確地把模型推向 with_graph。

## 4. Case A：主通道（附件正常）

步驟：

1. 送出固定 prompt。
2. 展開該次 graphrag_query_with_graph 的 tool call 區塊。
3. 確認看到 Knowledge Graph 視覺化，而非純 JSON 文字。
4. 在 output 文字確認有 graph_id: <value>。

Pass 條件：

- 有 Knowledge Graph 卡片
- 有節點/邊資訊（例如 X nodes | Y edges）
- output 內有 graph_id

Fail 條件：

- 無圖、只有純文字
- 沒有 graph_id

## 5. Case B：附件丟失模擬（同訊息重渲染）

目標：模擬 ui_resources 附件消失，驗證前端是否會走 graph_id 重抓。

### B-1. 先記錄 graph_id

在剛剛同一筆 tool output 找到 graph_id，記成一個字串（例如 3a4a8d29f4f6d0db）。

### B-2. 在 DevTools Console 套用「附件丟失」攔截腳本

把下列 GRAPH_ID 換成你的值，然後貼到 Console 執行：

```js
(() => {
  const GRAPH_ID = 'REPLACE_WITH_GRAPH_ID';

  if (window.__graphragRestoreFetch) {
    window.__graphragRestoreFetch();
  }

  const originalFetch = window.fetch.bind(window);

  function stripAttachments(payload) {
    if (Array.isArray(payload)) {
      return payload.map(stripAttachments);
    }

    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const copy = { ...payload };

    const toolName = typeof copy.toolName === 'string' ? copy.toolName : '';
    const output = typeof copy.output === 'string' ? copy.output : '';
    const isGraphCall = toolName.includes('graphrag_query_with_graph');
    const hasGraphId = output.includes(`graph_id: ${GRAPH_ID}`) || output.includes(GRAPH_ID);

    if (isGraphCall && hasGraphId) {
      copy.attachments = [];
    }

    for (const [k, v] of Object.entries(copy)) {
      if (v && typeof v === 'object') {
        copy[k] = stripAttachments(v);
      }
    }

    return copy;
  }

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    if (!requestUrl.includes('/api/agents/tools/calls')) {
      return response;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return response;
    }

    try {
      const json = await response.clone().json();
      const patched = stripAttachments(json);
      return new Response(JSON.stringify(patched), {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    } catch {
      return response;
    }
  };

  window.__graphragRestoreFetch = () => {
    window.fetch = originalFetch;
    delete window.__graphragRestoreFetch;
  };

  console.log('GraphRAG attachment-loss simulation enabled. Refresh the page to verify refetch.');
})();
```

完成後重新整理頁面並回到同一訊息。

### B-3. 驗證 Network 與 UI

Pass 條件：

- 前端可從 output 抽出 graph_id
- 發出重抓請求：POST /api/mcp/<server>/tools/graphrag_get_graph_by_id/call
- 重抓成功後，Knowledge Graph 再次顯示

Fail 條件：

- 有 graph_id 但沒發重抓
- 已重抓成功但圖沒回來

## 6. Case C：摘要輸出 fallback

目標：即使 output 被摘要，仍可恢復圖。

步驟：

1. 維持附件丟失模擬。
2. 用 Local Overrides 或攔截方式，把目標 tool output 改成類似：

```text
Conversation summarized...
graph_id: <same_graph_id>
```

3. 重新渲染該訊息。

Pass 條件：

- 不會永久停在摘要文字
- 會走 cache 或 graph_id 重抓
- 最終恢復 Knowledge Graph

## 7. 必拍截點

每次回歸至少保留以下證據：

1. A_main_channel_ok.png：主通道正常顯示圖
2. A_graph_id_present.png：同訊息有 graph_id
3. B_refetch_request_ok.png：有重抓請求與狀態碼
4. B_refetch_ui_recovered.png：重抓後圖恢復
5. C_summarized_output_recovered.png：摘要情境也恢復

## 8. 回歸清單（PASS/FAIL）

- [ ] A1: graphrag_query_with_graph 回覆包含 graph_id
- [ ] A2: 附件存在時直接顯示圖
- [ ] B1: 附件缺失時可從 output 抽出 graph_id
- [ ] B2: 觸發 graphrag_get_graph_by_id 請求
- [ ] B3: 重抓成功後同訊息恢復顯示圖
- [ ] C1: 摘要文字情境下仍可恢復圖（cache 或 by-id）
- [ ] C2: 恢復後節點/邊資訊非空且符合查詢主題

## 9. 快速故障定位

1. 沒 graph_id：後端摘要契約異常
2. 有 graph_id、無重抓：前端觸發條件未命中
3. 有重抓、回 4xx/5xx：MCP server 或 graph cache 異常
4. 重抓成功、仍無圖：前端 payload 解析或渲染異常

## 10. Issue 回報模板

```md
## GraphRAG UI Reliability Regression

- Date:
- Commit:
- Environment: local docker / browser version

### Case A (main channel)
- Result: PASS/FAIL
- graph_id present: yes/no
- Screenshot:

### Case B (attachment loss simulation)
- Result: PASS/FAIL
- Refetch request observed: yes/no
- Refetch response status:
- Screenshot:

### Case C (summarized fallback)
- Result: PASS/FAIL
- Recovered via: cache / graph_id refetch / no
- Screenshot:

### Notes
-
```

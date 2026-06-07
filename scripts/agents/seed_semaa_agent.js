/**
 * Seed or update the shared SEMAA agent on semaa.site MongoDB.
 *
 * Usage:
 *   docker exec -i chat-mongodb mongosh LibreChat < scripts/agents/seed_semaa_agent.js
 *
 * Or from host with mongosh URI:
 *   mongosh "mongodb://localhost:27017/LibreChat" < scripts/agents/seed_semaa_agent.js
 */

const AGENT_ID = 'agent_SemaaGRVP2026x';
const AGENT_NAME = 'SEMAA';
const GRAPHRAG_SERVER = 'graphrag-local';
const MCP_DELIMITER = '_mcp_';
const MCP_SERVER_PREFIX = 'sys__server__sys';

const GRAPHRAG_TOOL_NAMES = [
  'graphrag_ingest_document',
  'graphrag_query_with_graph',
  'graphrag_get_graph_by_id',
  'graphrag_batch_query_knowledge',
  'graphrag_ingest_uploaded_file',
  'graphrag_list_uploaded_text_files',
  'graphrag_list_documents',
  'graphrag_delete_documents',
];

function buildGraphragTools() {
  const tools = [`${MCP_SERVER_PREFIX}${MCP_DELIMITER}${GRAPHRAG_SERVER}`];
  for (const toolName of GRAPHRAG_TOOL_NAMES) {
    tools.push(`${toolName}${MCP_DELIMITER}${GRAPHRAG_SERVER}`);
  }
  return tools;
}

const INSTRUCTIONS = `# Rules

You are SEMAA, an AI assistant on semaa.site. You help engineers work with technical documents and SysML-style models in Visual Paradigm.

Your primary capability sets are:

1. **GraphRAG** — index uploaded \`.md\` / \`.txt\` documents and answer questions with grounded evidence and knowledge-graph context.
2. **Visual Paradigm MCP** — when connected, inspect the active diagram and create or update diagrams in Visual Paradigm, including requirement diagrams.

Do not invent facts for document questions. Use GraphRAG retrieval first and cite evidence. Do not paste truncated document summaries when a full uploaded file is available.

## Capability routing

- **Document upload, indexing, search, Q&A, traceability from specs** → use GraphRAG tools.
- **Class, use case, sequence, activity, state, component, deployment diagrams in VP** → use Visual Paradigm MCP tools with PlantUML when available.
- **Requirement diagrams in Visual Paradigm** → use Visual Paradigm MCP tools with SEMAA custom requirement syntax (\`@startreq\` / \`@endreq\`), not PlantUML.
- If a request spans both, retrieve grounded requirements or constraints from GraphRAG first when source documents are available, then create or update the Visual Paradigm diagram when the engineer wants the result in VP.

Never mix PlantUML syntax and SEMAA requirement syntax in the same diagram.

## GraphRAG workflow

When the engineer uploads \`.md\` or \`.txt\` files or asks questions about indexed documents:

1. For new uploads, call \`graphrag_ingest_uploaded_file\` with the exact filename. Do not paste shortened summaries into \`graphrag_ingest_document\`.
2. For questions, call \`graphrag_query_with_graph\` before answering.
3. Base answers only on returned evidence. Cite each factual claim as \`(source: filename#chunk-N; context: "quoted text")\`.
4. If no evidence matches, say the answer is not in the indexed documents.
5. To list indexed docs, use \`graphrag_list_documents\`. To remove docs, use \`graphrag_delete_documents\`.

Prefer \`graphrag_ingest_uploaded_file\` over \`graphrag_ingest_document\` whenever the engineer attached a file in LibreChat.

## Mandatory Visual Paradigm Tool Workflow

When Visual Paradigm MCP tools are available, use them in this order for diagram work:

1. Call \`get_current_diagram\` to inspect the active Visual Paradigm context.
2. Use that context and the user's request to design the diagram.
3. Generate valid diagram source.
4. Call \`create_diagram\` with the generated source.
5. After tool execution, summarize modeling decisions and validation checks concisely.

Do not skip the current-context tool call. Do not only print source code when \`create_diagram\` is available.

## Diagram syntax selection

Use PlantUML for supported diagram types:

- Class Diagram
- Use Case Diagram
- Sequence Diagram
- Activity Diagram
- State Machine Diagram
- Component Diagram
- Deployment Diagram

Use SEMAA custom requirement syntax for:

- Requirement Diagram

## Responsibilities

1. **Code generation** — translate natural-language requests, GraphRAG evidence, and structured input into the correct diagram syntax. Validate syntax before calling \`create_diagram\`.
2. **Design review** — analyze diagram code for missing relationships, invalid endpoints, naming clashes, unsupported syntax, and weak SysML modeling. Give concise, actionable suggestions.
3. **Interactive loop** — on follow-up prompts, merge new requests with existing Visual Paradigm context instead of discarding prior design intent.

# Requirement Diagram Syntax

Requirement diagrams use SEMAA custom syntax imported by Visual Paradigm.

## Strict importer rules

- Exactly one \`@startreq\` and one \`@endreq\` marker.
- No PlantUML syntax in requirement diagrams.
- Only requirement blocks and one \`relationships { }\` block.
- Do not define \`element\` blocks.
- Do not use \`id:\` or \`type:\` fields; use \`kind:\`.
- Each requirement block fields in order: \`text:\`, \`kind:\`, \`risk:\`, \`verifymethod:\`
- Relationship lines inside \`relationships { }\`.
- Every relationship source/target must match a defined requirement name.
- Use identifier-style names without spaces, e.g. \`SHIP_REQ_001\`.
- Do not use quoted requirement names in relationships.

## Requirement block

\`\`\`
@startreq
    requirement REQ_NAME {
        text: "Requirement text"
        kind: requirement
        risk: medium
        verifymethod: analysis
    }
@endreq
\`\`\`

Valid \`kind\`: \`requirement\`, \`functional\`, \`interface\`, \`performance\`
Valid \`risk\`: \`low\`, \`medium\`, \`high\`
Valid \`verifymethod\`: \`analysis\`, \`inspection\`, \`test\`, \`demonstration\`

## Relationship block

\`\`\`
    relationships {
        SOURCE_REQ - contains -> TARGET_REQ
        SOURCE_REQ - traces -> OTHER_REQ
    }
\`\`\`

Valid relationship types: \`contains\`, \`copies\`, \`derives\`, \`satisfies\`, \`verifies\`, \`refines\`, \`traces\`

Use \`contains\` for decomposition, \`derives\` for derived requirements, \`refines\` for more specific requirements, \`satisfies\` for design satisfaction, \`verifies\` for verification links, and \`traces\` for traceability.

## Requirement modeling guidance

- Create a top-level system requirement when appropriate.
- Decompose into coherent groups (mission, dimensions, performance, regulations, interfaces, safety, constraints).
- Use 12-25 requirements when source material supports that detail.
- Assign \`high\` risk to safety, regulatory, mission-critical, or performance-critical requirements.

Before creating a requirement diagram, validate that every requirement has the four fields in order, enums are valid, relationship endpoints exist, and relationship types are valid.

## Building requirement diagrams from documents

When the engineer wants a requirement diagram from uploaded specifications:

1. Ensure source documents are indexed in GraphRAG.
2. Query GraphRAG for relevant requirements, constraints, and relationships.
3. Synthesize SEMAA requirement syntax from grounded evidence only.
4. If Visual Paradigm is connected, call \`create_diagram\` to import the diagram.
5. Cite which document chunks informed each requirement when summarizing the result.
`;

function findAdminAuthor() {
  const admin =
    db.users.findOne({ role: 'ADMIN' }, { sort: { createdAt: 1 } }) ||
    db.users.findOne({}, { sort: { createdAt: 1 } });
  if (!admin) {
    throw new Error('No users found in database; create an admin user first.');
  }
  return admin;
}

function getAccessRole(accessRoleId) {
  const role = db.accessroles.findOne({ accessRoleId, resourceType: 'agent' });
  if (!role) {
    throw new Error(`Missing access role: ${accessRoleId}`);
  }
  return role;
}

function mergeTools(existingTools) {
  const graphragTools = buildGraphragTools();
  const preserved = (existingTools || []).filter(
    (tool) => typeof tool === 'string' && tool.includes(`${MCP_DELIMITER}vp-`),
  );
  return Array.from(new Set([...graphragTools, ...preserved]));
}

const now = new Date();
const author = findAdminAuthor();
const ownerRole = getAccessRole('agent_owner');
const viewerRole = getAccessRole('agent_viewer');
const graphragTools = buildGraphragTools();

const baseAgent = {
  id: AGENT_ID,
  name: AGENT_NAME,
  description:
    'SEMAA assistant for GraphRAG document Q&A and Visual Paradigm requirement diagrams (GPT-5.5).',
  instructions: INSTRUCTIONS,
  provider: 'openAI',
  model: 'gpt-5.5',
  model_parameters: {},
  artifacts: '',
  category: 'general',
  conversation_starters: [
    'Index my uploaded specification and answer questions with citations.',
    'Create a requirement diagram in Visual Paradigm from my indexed documents.',
    'What documents are currently indexed in GraphRAG?',
  ],
  tools: graphragTools,
  mcpServerNames: [GRAPHRAG_SERVER],
  is_promoted: true,
  author: author._id,
  authorName: author.username || author.name || 'SEMAA',
  agent_ids: [],
  edges: [],
  tool_kwargs: [],
  actions: [],
  updatedAt: now,
};

const existing = db.agents.findOne({ id: AGENT_ID }) || db.agents.findOne({ name: AGENT_NAME });

if (!existing) {
  db.agents.insertOne({
    ...baseAgent,
    tools: graphragTools,
    versions: [
      {
        ...baseAgent,
        id: AGENT_ID,
        tools: graphragTools,
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
  });
  print(`Created agent ${AGENT_ID} (${AGENT_NAME})`);
} else {
  const mergedTools = mergeTools(existing.tools);
  const mcpNames = Array.from(
    new Set([
      GRAPHRAG_SERVER,
      ...(existing.mcpServerNames || []).filter((name) => String(name).startsWith('vp-')),
    ]),
  );

  db.agents.updateOne(
    { _id: existing._id },
    {
      $set: {
        name: AGENT_NAME,
        description: baseAgent.description,
        instructions: INSTRUCTIONS,
        provider: 'openAI',
        model: 'gpt-5.5',
        tools: mergedTools,
        mcpServerNames: mcpNames,
        conversation_starters: baseAgent.conversation_starters,
        is_promoted: true,
        actions: [],
        updatedAt: now,
      },
    },
  );
  print(`Updated agent ${existing.id} (${AGENT_NAME})`);
}

const agentDoc = db.agents.findOne({ id: AGENT_ID }) || db.agents.findOne({ name: AGENT_NAME });
if (!agentDoc) {
  throw new Error('Agent seed failed');
}

const ownerAcl = db.aclentries.findOne({
  resourceType: 'agent',
  resourceId: agentDoc._id,
  principalType: 'user',
  principalId: author._id,
});

if (!ownerAcl) {
  db.aclentries.insertOne({
    principalType: 'user',
    principalModel: 'User',
    principalId: author._id,
    resourceType: 'agent',
    resourceId: agentDoc._id,
    permBits: ownerRole.permBits,
    roleId: ownerRole._id,
    grantedBy: author._id,
    grantedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  print('Created owner ACL for admin');
}

const publicAcl = db.aclentries.findOne({
  resourceType: 'agent',
  resourceId: agentDoc._id,
  principalType: 'public',
});

if (!publicAcl) {
  db.aclentries.insertOne({
    principalType: 'public',
    resourceType: 'agent',
    resourceId: agentDoc._id,
    permBits: viewerRole.permBits,
    roleId: viewerRole._id,
    grantedBy: author._id,
    grantedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  print('Created public viewer ACL (use without edit)');
} else if (publicAcl.permBits !== viewerRole.permBits) {
  db.aclentries.updateOne(
    { _id: publicAcl._id },
    { $set: { permBits: viewerRole.permBits, roleId: viewerRole._id, updatedAt: now } },
  );
  print('Refreshed public viewer ACL');
}

print(`SEMAA agent ready: id=${agentDoc.id} name=${agentDoc.name}`);
print(`Set VISUAL_PARADIGM_AGENT_ID=${agentDoc.id}`);
print('Set VISUAL_PARADIGM_AGENT_NAMES=SEMAA');

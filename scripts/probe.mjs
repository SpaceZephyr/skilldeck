// 探针：用 MCP 客户端连上 server.mjs（stdio），列出工具、拉取 widget resource，验证注册正确。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'mcp', 'server.mjs');

const transport = new StdioClientTransport({ command: 'node', args: [serverPath] });
const client = new Client({ name: 'skilldeck-probe', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log('工具:', tools.tools.map((t) => t.name).join(', '));

// 检查 open_skilldeck 的 widget 元数据
const open = tools.tools.find((t) => t.name === 'open_skilldeck');
console.log('open_skilldeck outputTemplate:', open?._meta?.['openai/outputTemplate']);

// 调 list_skills，看能否读到本地 Skill
const res = await client.callTool({ name: 'list_skills', arguments: {} });
const sc = res.structuredContent || {};
console.log('list_skills 读到 Skill 数:', (sc.skills || []).length, '| 目录:', sc.dir);
console.log('样例前 3:', (sc.skills || []).slice(0, 3).map((s) => `${s.name}[${s.category}]`).join(', '));

// 拉取 widget resource，确认桥接脚本已注入
try {
  const resources = await client.listResources();
  console.log('resources:', (resources.resources || []).map((r) => r.uri).join(', '));
  const uri = 'ui://widget/skilldeck/deck.html';
  const r = await client.readResource({ uri });
  const html = (r.contents && r.contents[0] && r.contents[0].text) || '';
  console.log('widget HTML 长度:', html.length,
    '| 含桥接:', html.includes('skilldeckMcp') || html.includes('sendFollowUpMessage'),
    '| 含卡片JS:', html.includes('sd-use') || html.includes('SkillDeck'));
} catch (e) {
  console.log('读取 widget resource 失败:', e.message);
}

await client.close();
process.exit(0);

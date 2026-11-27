export const TOOL_GROUPS = [
  { id: 'image', label: '图片', tools: [
    { id: 'all', label: '组合处理' },
    { id: 'transform', label: '变换' },
    { id: 'compress', label: '压缩' },
    { id: 'fill', label: '填充' },
    { id: 'color', label: '色彩' },
  ] },
  { id: 'pdf', label: 'PDF', tools: [
    { id: 'rotate', label: '旋转' },
    { id: 'split', label: '拆分' },
    { id: 'merge', label: '合并' },
    { id: 'extractPages', label: '提取页面' },
    { id: 'extractText', label: '提取文本' },
    { id: 'extractImages', label: '提取图片' },
    { id: 'render', label: '渲染图片' },
  ] },
  { id: 'video', label: '视频', tools: [{ id: 'transcode', label: '转码' }] },
  { id: 'documents', label: '文档', tools: [
    { id: 'docx2pdf', label: 'Word → PDF' },
    { id: 'pdf2docx', label: 'PDF → Word' },
  ] },
] as const;

type Groups = typeof TOOL_GROUPS;
export type ToolRoute = {
  [Group in Groups[number] as Group['id']]: {
    group: Group['id'];
    section: Group['tools'][number]['id'];
  };
}[Groups[number]['id']];
export type Route = ToolRoute | { group: 'help'; section: 'info' };

export function resolveRoute(hash: string): Route {
  const [, group, section] = hash.split('/');
  if (group === 'help') return { group: 'help', section: 'info' };
  const match = TOOL_GROUPS.find((item) => item.id === group) ?? TOOL_GROUPS[0];
  const tool = match.tools.find((item) => item.id === section) ?? match.tools[0];
  // The section is selected only from this group's own tools.
  return { group: match.id, section: tool.id } as ToolRoute;
}

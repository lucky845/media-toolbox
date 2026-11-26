// mammoth 的浏览器构建没有随包 TypeScript 声明（@types/mammoth 只覆盖 node 主入口）。
// 我们只用到 extractRawText，声明最小接口即可。
declare module 'mammoth/mammoth.browser' {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}

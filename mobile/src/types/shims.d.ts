// npm "process" (the browser version of Node's process, for GramJS) has no types of its own.
declare module "process" {
  const process: { env: Record<string, string>; [key: string]: unknown };
  export default process;
}

import { Channel, invoke } from '@tauri-apps/api/core';
import { ExecutionError, FileError, err, loadSkills, ok, type ExecutionEnv, type Skill } from '@earendil-works/pi-agent-core';

type FsRequest = { workspace: string; op: string; path: string; secondPath?: string; content?: string; recursive?: boolean; force?: boolean };
type FileInfo = { name: string; path: string; kind: 'file' | 'directory' | 'symlink'; size: number; mtimeMs: number };

const errorText = (error: unknown) => String((error as Error)?.message || error).slice(0, 500);
const fileFailure = <T>(error: unknown, path?: string) => err<T, FileError>(new FileError(/文件不存在|os error 2|os error 3/.test(errorText(error)) ? 'not_found' : /边界|受保护|权限/.test(errorText(error)) ? 'permission_denied' : 'unknown', errorText(error), path));
const base64FromBytes = (bytes: Uint8Array | ArrayBuffer) => {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let index = 0; index < value.length; index += 0x8000) text += String.fromCharCode(...value.subarray(index, index + 0x8000));
  return btoa(text);
};

async function fsCall(request: FsRequest): Promise<any> {
  return invoke('execution_fs', { request });
}

export interface PiDependency { available: boolean; path: string; version: string; }

export function createExecutionEnv(workspace: string, shell: 'powershell' | 'bash' | 'python' | 'node' = 'powershell'): ExecutionEnv {
  const call = async <T>(request: Omit<FsRequest, 'workspace'>, path?: string) => {
    try { return ok<T, FileError>(await fsCall({ ...request, workspace })); }
    catch (error) { return fileFailure<T>(error, path || request.path); }
  };
  return {
    cwd: workspace,
    absolutePath: (path) => call<string>({ op: 'absolute', path }, path),
    joinPath: (parts) => call<string>({ op: 'join', path: parts.join('/') }),
    readTextFile: (path) => call<string>({ op: 'read_text', path }, path),
    readTextLines: async (path, options) => {
      const result = await call<string>({ op: 'read_text', path }, path);
      if (!result.ok) return result;
      const lines = result.value.split(/\r?\n/);
      return ok(options?.maxLines ? lines.slice(0, options.maxLines) : lines);
    },
    readBinaryFile: async (path) => {
      const result = await call<{ base64: string }>({ op: 'read_binary', path }, path);
      if (!result.ok) return result;
      try {
        const raw = atob(result.value.base64);
        return ok(Uint8Array.from(raw, char => char.charCodeAt(0)));
      } catch (error) { return fileFailure<Uint8Array>(error, path); }
    },
    writeFile: (path, content) => call<void>({ op: typeof content === 'string' ? 'write_text' : 'write_binary', path, content: typeof content === 'string' ? content : base64FromBytes(content as Uint8Array | ArrayBuffer) }, path),
    appendFile: (path, content) => call<void>({ op: typeof content === 'string' ? 'append_text' : 'append_binary', path, content: typeof content === 'string' ? content : base64FromBytes(content as Uint8Array | ArrayBuffer) }, path),
    renameFile: (sourcePath, destinationPath) => call<void>({ op: 'rename', path: sourcePath, secondPath: destinationPath }, sourcePath),
    fileInfo: (path) => call<FileInfo>({ op: 'info', path }, path),
    listDir: (path) => call<FileInfo[]>({ op: 'list', path }, path),
    canonicalPath: (path) => call<string>({ op: 'canonical', path }, path),
    exists: (path) => call<boolean>({ op: 'exists', path }, path),
    createDir: (path) => call<void>({ op: 'mkdir', path }, path),
    remove: (path) => call<void>({ op: 'remove', path }, path),
    createTempDir: async (prefix = 'tmp-') => {
      const path = `${prefix}${Date.now()}`;
      const result = await call<void>({ op: 'mkdir', path }, path);
      return result.ok ? ok(`${workspace}/${path}`) : result;
    },
    createTempFile: async (options = {}) => {
      const path = `${options.prefix || ''}${Date.now()}${options.suffix || ''}`;
      const result = await call<void>({ op: 'write_text', path, content: '' }, path);
      return result.ok ? ok(`${workspace}/${path}`) : result;
    },
    exec: async (command, options = {}) => {
      if (options.abortSignal?.aborted) return err(new ExecutionError('aborted', '命令已取消，未启动'));
      const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let cancelled = false;
      const abort = () => { cancelled = true; void invoke('execution_cancel', { executionId }).catch(() => {}); };
      options.abortSignal?.addEventListener('abort', abort, { once: true });
      try {
        await invoke('execution_prepare', { executionId });
        if (cancelled || options.abortSignal?.aborted) await invoke('execution_cancel', { executionId });
        const output = new Channel<{ stream: string; text: string }>();
        output.onmessage = chunk => { if (chunk.stream === 'stdout') options.onStdout?.(chunk.text); else options.onStderr?.(chunk.text); };
        const result = await invoke<{ stdout: string; stderr: string; exitCode: number; cancelled: boolean; timedOut: boolean; fullOutputPath: string }>('execution_exec', {
          request: { executionId, workspace, command, timeoutSeconds: options.timeout ? Math.ceil(options.timeout) : undefined, shell, isolated: true }, output,
        });
        if (cancelled || result.cancelled) return err(new ExecutionError('aborted', '命令已取消'));
        if (result.timedOut) return err(new ExecutionError('timeout', `命令超过 ${options.timeout || 120} 秒`));
        return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, fullOutputPath: result.fullOutputPath });
      } catch (error) { return err(new ExecutionError(cancelled || options.abortSignal?.aborted ? 'aborted' : /超过.*秒/.test(errorText(error)) ? 'timeout' : 'spawn_error', errorText(error))); }
      finally { options.abortSignal?.removeEventListener('abort', abort); }
    },
    cleanup: async () => { },
  };
}

export interface PiExecutionContext {
  workspace: string;
  env: ExecutionEnv;
  bashEnv?: ExecutionEnv;
  pythonEnv?: ExecutionEnv;
  nodeEnv?: ExecutionEnv;
  dependencies: Record<string, PiDependency>;
  skills: Skill[];
  diagnostics: string[];
  shellEnabled: boolean;
}

export async function createPiExecutionContext(existingWorkspace?: string, shellEnabled = false): Promise<PiExecutionContext> {
  const workspace = shellEnabled
    ? await invoke<string>('execution_create_isolated_workspace')
    : existingWorkspace || await invoke<string>('execution_create_workspace');
  await invoke('execution_set_enabled', { workspace, enabled: shellEnabled });
  const dependencies = shellEnabled ? await invoke<Record<string, PiDependency>>('execution_dependencies').catch(() => ({} as Record<string, PiDependency>)) : {} as Record<string, PiDependency>;
  const env = createExecutionEnv(workspace);
  const bashEnv = dependencies.bash?.available ? createExecutionEnv(workspace, 'bash') : undefined;
  const pythonEnv = dependencies.python?.available ? createExecutionEnv(workspace, 'python') : undefined;
  const nodeEnv = dependencies.node?.available ? createExecutionEnv(workspace, 'node') : undefined;
  const dirs = await invoke<string[]>('execution_skill_dirs', { workspace });
  const loaded = await loadSkills(env, dirs);
  const diagnostics = loaded.diagnostics.map(item => item.message);
  if (shellEnabled) for (const name of ['python', 'node', 'git']) if (!dependencies[name]?.available) diagnostics.push(`未检测到 ${name}，相关 Skill 可能无法执行`);
  return { workspace, env, bashEnv, pythonEnv, nodeEnv, dependencies, skills: loaded.skills, diagnostics, shellEnabled };
}

export async function openPiExecutionPath(workspace: string, path = '.') {
  await invoke('execution_open_path', { workspace, path });
}

export async function copyPiAttachment(context: PiExecutionContext, name: string, source: string) {
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '') || 'attachment.bin';
  const payload = source.replace(/^data:[^;]+;base64,/, '');
  const raw = atob(payload);
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  const result = await context.env.writeFile(safeName, bytes);
  if (!result.ok) throw result.error;
  // Keep the model-facing name relative; the execution bridge resolves it inside the task workspace.
  return safeName;
}

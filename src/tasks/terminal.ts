import { dirname, join, basename } from 'path';
import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import { mkdirSync, existsSync, copyFileSync, rmSync, chmodSync } from 'fs';
import { platform } from 'os';
import * as vscode from 'vscode';

import type { DefoldBuildTaskDefinition, DefoldTaskEnv } from '../types';
import output from '../output';

const HOST: Record<NodeJS.Platform, DefoldBuildTaskDefinition['platform']> = {
  darwin: 'macOS',
  win32: 'windows',
  cygwin: 'windows',
  linux: 'linux',
  aix: 'linux',
  freebsd: 'linux',
  sunos: 'linux',
  openbsd: 'linux',
  netbsd: 'linux',
  android: 'android',
};

const PLATFORMS: Record<DefoldBuildTaskDefinition['platform'], string> = {
  current: '',
  android: 'armv7-android',
  ios: 'armv7-darwin',
  macOS: 'x86_64-darwin',
  windows: 'x86_64-win32',
  linux: 'x86_64-linux',
  html5: 'js-web',
};

export class DefoldTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose?: vscode.Event<number> = this.closeEmitter.event;

  private process: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private workspaceRoot: string,
    private project: string,
    private definition: DefoldBuildTaskDefinition,
    private env: DefoldTaskEnv,
    private flags: string[]
  ) {}

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    // TODO: If we are here and have no env, what should we do?
    if (!this.env) {
      this.closeEmitter.fire(1);
      return;
    }

    const config = vscode.workspace.getConfiguration('defold');
    const projectDir = dirname(this.project);
    const target = this.definition.platform === 'current' ? HOST[platform()] : this.definition.platform;
    const java = `${this.env.java}`;
    const jar = join(this.env.jdk, 'bin', 'jar');
    const required = [
      `-cp`,
      `${this.env.jar}`,
      `com.dynamo.bob.Bob`,
      `--input`,
      `"${projectDir}"`,
      `--root`,
      `"${projectDir}"`,
    ];

    let exec = java;
    let options: string[] = [];
    let commands: string[] = [];

    switch (this.definition.action) {
      case 'build':
        {
          options = [
            ...required,
            `--email`,
            `${config.get<string>('build.email') ?? ''}`,
            `--auth`,
            `${config.get<string>('build.auth') ?? ''}`,
          ];
          commands = [`resolve`, `build`];
        }
        break;
      case 'bundle':
        {
          const out = join(this.workspaceRoot, 'bundle', target);
          try {
            mkdirSync(out, { recursive: true });
          } catch (e) {
            /* ignore */
          }

          options = [
            ...required,
            `--email`,
            `${config.get<string>('build.email') ?? ''}`,
            `--auth`,
            `${config.get<string>('build.auth') ?? ''}`,
            `--archive`,
            `--platform`,
            `${PLATFORMS[target]}`,
            `--variant`,
            `${this.definition.configuration}`,
            this.definition.configuration === 'release' ? `--strip-executable` : '',
            `--bundle-output`,
            `"${out}"`,
            `--build-report-html`,
            `${join(out, 'build-report.html')}`,
          ];
          commands = [`resolve`, `distclean`, `build`, `bundle`];
        }
        break;
      case 'clean':
        {
          options = [...required];
          commands = [`distclean`];
        }
        break;
      case 'resolve':
        {
          options = [
            ...required,
            `--email`,
            `${config.get<string>('build.email') ?? ''}`,
            `--auth`,
            `${config.get<string>('build.auth') ?? ''}`,
          ];
          commands = [`resolve`];
        }
        break;
      case 'run':
        {
          const out = join(projectDir, 'build', 'default');
          exec = join(out, platform() === 'win32' ? 'dmengine.exe' : 'dmengine');
          options = [];
          commands = [join(out, 'game.projectc')];

          if (!existsSync(exec)) {
            this.writeEmitter.fire(`Build before running`);
            this.closeEmitter.fire(1);
            return;
          }
        }
        break;
    }

    // Execute the command
    this.exec(exec, [...options, ...commands]);

    // Post actions
    switch (this.definition.action) {
      case 'build':
        {
          let path = '';
          switch (platform()) {
            case 'darwin':
              path = '_unpack/x86_64-darwin/bin/dmengine';
              break;
            case 'win32':
              path = '_unpack/x86_64-win32/bin/dmengine.exe';
              break;
            default:
              path = '_unpack/x86_64-linux/bin/dmengine';
              break;
          }

          // Extract the engine binary if one was not generated by the build
          const out = join(projectDir, 'build', 'default');
          if (!existsSync(join(out, basename(path)))) {
            execSync(`${jar} -xf "${this.env.jar}" "${path}"`, { cwd: out });
            copyFileSync(join(out, path), join(out, basename(path)));
            rmSync(join(out, '_unpack'), { recursive: true, force: true });
            chmodSync(join(out, basename(path)), '755');
          }
        }
        break;
    }
  }

  close(): void {
    this.process?.kill();
  }

  private exec(command: string, args: string[]): void {
    output().appendLine(`Execute: ${command} ${args.join(' ')}`);
    this.process = spawn(command, args, { cwd: this.workspaceRoot });
    this.process.stdout.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString().replace(/\r?\n/, '\r\n'));
    });

    this.process.stderr.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString().replace(/\r?\n/, '\r\n'));
    });

    this.process.on('close', (code) => {
      this.closeEmitter.fire(code ?? 0);
    });
  }
}

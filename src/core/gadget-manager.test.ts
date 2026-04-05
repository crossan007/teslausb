import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandResult, CommandRunner } from '../shared/command-runner';
import { GadgetManager } from './gadget-manager';

class MockCommandRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return { code: 0, stdout: '', stderr: '' };
  }

  async runStreaming(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return { code: 0, stdout: '', stderr: '' };
  }
}

const tempDirs: string[] = [];

async function createTempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'teslausb-gadget-test-'));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('GadgetManager', () => {
  it('creates and enables gadget configfs structure', async () => {
    const root = await createTempRoot();
    const configfsRoot = join(root, 'configfs');
    const backingFilesDir = join(root, 'backingfiles');
    const machineIdPath = join(root, 'etc', 'machine-id');
    const modelPath = join(root, 'sys', 'model');
    const mountsPath = join(root, 'proc', 'mounts');
    const udcClassPath = join(root, 'sys', 'class', 'udc');

    await mkdir(configfsRoot, { recursive: true });
    await mkdir(backingFilesDir, { recursive: true });
    await mkdir(dirname(machineIdPath), { recursive: true });
    await mkdir(dirname(modelPath), { recursive: true });
    await mkdir(dirname(mountsPath), { recursive: true });
    await mkdir(join(udcClassPath, 'dummy.udc.0'), { recursive: true });

    await writeFile(machineIdPath, 'test-machine-id\n', 'utf-8');
    await writeFile(modelPath, 'Raspberry Pi 5\n', 'utf-8');
    await writeFile(mountsPath, `none ${configfsRoot} configfs rw 0 0\n`, 'utf-8');

    await writeFile(join(backingFilesDir, 'cam_disk.bin'), '');
    await writeFile(join(backingFilesDir, 'music_disk.bin'), '');
    await truncate(join(backingFilesDir, 'cam_disk.bin'), 16 * 1024 * 1024);
    await truncate(join(backingFilesDir, 'music_disk.bin'), 8 * 1024 * 1024);

    const runner = new MockCommandRunner();
    const manager = new GadgetManager({
      commandRunner: runner,
      paths: {
        backingFilesDir,
        machineIdPath,
        modelPath,
        configfsMountsPath: mountsPath,
        udcClassPath,
      },
    });

    await manager.enable();

    const gadgetRoot = join(configfsRoot, 'usb_gadget', 'teslausb');
    const maxPower = await readFile(join(gadgetRoot, 'configs', 'c.1', 'MaxPower'), 'utf-8');
    const udc = await readFile(join(gadgetRoot, 'UDC'), 'utf-8');
    const lun0 = await readFile(join(gadgetRoot, 'functions', 'mass_storage.0', 'lun.0', 'file'), 'utf-8');
    const lun1 = await readFile(join(gadgetRoot, 'functions', 'mass_storage.0', 'lun.1', 'file'), 'utf-8');

    expect(runner.calls[0]).toEqual({ command: 'modprobe', args: ['libcomposite'] });
    expect(maxPower.trim()).toBe('600');
    expect(udc.trim()).toBe('dummy.udc.0');
    expect(lun0.trim()).toBe(join(backingFilesDir, 'cam_disk.bin'));
    expect(lun1.trim()).toBe(join(backingFilesDir, 'music_disk.bin'));
  });

  it('disables gadget and unloads modules', async () => {
    const root = await createTempRoot();
    const configfsRoot = join(root, 'configfs');
    const gadgetRoot = join(configfsRoot, 'usb_gadget', 'teslausb');
    const mountsPath = join(root, 'proc', 'mounts');
    const machineIdPath = join(root, 'etc', 'machine-id');
    const modelPath = join(root, 'sys', 'model');
    const udcClassPath = join(root, 'sys', 'class', 'udc');
    const backingFilesDir = join(root, 'backingfiles');

    await mkdir(join(gadgetRoot, 'configs', 'c.1'), { recursive: true });
    await mkdir(dirname(mountsPath), { recursive: true });
    await mkdir(dirname(machineIdPath), { recursive: true });
    await mkdir(dirname(modelPath), { recursive: true });
    await mkdir(udcClassPath, { recursive: true });
    await mkdir(backingFilesDir, { recursive: true });
    await writeFile(join(gadgetRoot, 'UDC'), 'dummy.udc.0\n', 'utf-8');
    await writeFile(mountsPath, `none ${configfsRoot} configfs rw 0 0\n`, 'utf-8');
    await writeFile(machineIdPath, 'test-machine-id\n', 'utf-8');
    await writeFile(modelPath, 'Raspberry Pi 4\n', 'utf-8');

    const runner = new MockCommandRunner();
    const manager = new GadgetManager({
      commandRunner: runner,
      paths: {
        backingFilesDir,
        machineIdPath,
        modelPath,
        configfsMountsPath: mountsPath,
        udcClassPath,
      },
    });

    await manager.disable();

    expect(runner.calls[0]).toEqual({ command: 'modprobe', args: ['-q', '-r', 'g_mass_storage'] });
    expect(runner.calls[1]).toEqual({
      command: 'modprobe',
      args: ['-r', 'usb_f_mass_storage', 'g_ether', 'usb_f_ecm', 'usb_f_rndis', 'libcomposite'],
    });
    await expect(readFile(join(gadgetRoot, 'UDC'), 'utf-8')).rejects.toThrow();
  });

  it('is idempotent when gadget root already exists', async () => {
    const root = await createTempRoot();
    const configfsRoot = join(root, 'configfs');
    const gadgetRoot = join(configfsRoot, 'usb_gadget', 'teslausb');
    const mountsPath = join(root, 'proc', 'mounts');
    const machineIdPath = join(root, 'etc', 'machine-id');
    const modelPath = join(root, 'sys', 'model');
    const udcClassPath = join(root, 'sys', 'class', 'udc');
    const backingFilesDir = join(root, 'backingfiles');

    await mkdir(gadgetRoot, { recursive: true });
    await mkdir(dirname(mountsPath), { recursive: true });
    await mkdir(dirname(machineIdPath), { recursive: true });
    await mkdir(dirname(modelPath), { recursive: true });
    await mkdir(udcClassPath, { recursive: true });
    await mkdir(backingFilesDir, { recursive: true });
    await writeFile(mountsPath, `none ${configfsRoot} configfs rw 0 0\n`, 'utf-8');
    await writeFile(machineIdPath, 'test-machine-id\n', 'utf-8');
    await writeFile(modelPath, 'Raspberry Pi Zero 2\n', 'utf-8');

    const runner = new MockCommandRunner();
    const manager = new GadgetManager({
      commandRunner: runner,
      paths: {
        backingFilesDir,
        machineIdPath,
        modelPath,
        configfsMountsPath: mountsPath,
        udcClassPath,
      },
    });

    await manager.enable();
    expect(runner.calls).toHaveLength(0);
  });

  it('unloads legacy g_ether before creating configfs gadget', async () => {
    const root = await createTempRoot();
    const configfsRoot = join(root, 'configfs');
    const backingFilesDir = join(root, 'backingfiles');
    const machineIdPath = join(root, 'etc', 'machine-id');
    const modelPath = join(root, 'sys', 'model');
    const mountsPath = join(root, 'proc', 'mounts');
    const modulesPath = join(root, 'proc', 'modules');
    const udcClassPath = join(root, 'sys', 'class', 'udc');

    await mkdir(configfsRoot, { recursive: true });
    await mkdir(backingFilesDir, { recursive: true });
    await mkdir(dirname(machineIdPath), { recursive: true });
    await mkdir(dirname(modelPath), { recursive: true });
    await mkdir(dirname(mountsPath), { recursive: true });
    await mkdir(join(udcClassPath, 'dummy.udc.0'), { recursive: true });

    await writeFile(machineIdPath, 'test-machine-id\n', 'utf-8');
    await writeFile(modelPath, 'Raspberry Pi 4\n', 'utf-8');
    await writeFile(mountsPath, `none ${configfsRoot} configfs rw 0 0\n`, 'utf-8');
    await writeFile(modulesPath, 'g_ether 24576 0 - Live 0x00000000\n', 'utf-8');
    await writeFile(join(backingFilesDir, 'cam_disk.bin'), '');

    const runner = new MockCommandRunner();
    const manager = new GadgetManager({
      commandRunner: runner,
      paths: {
        backingFilesDir,
        machineIdPath,
        modelPath,
        configfsMountsPath: mountsPath,
        procModulesPath: modulesPath,
        udcClassPath,
      },
    });

    await manager.enable();

    expect(runner.calls[0]).toEqual({ command: 'modprobe', args: ['-r', 'g_ether'] });
    expect(runner.calls[1]).toEqual({ command: 'modprobe', args: ['libcomposite'] });
  });
});

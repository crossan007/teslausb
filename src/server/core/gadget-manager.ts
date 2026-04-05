/**
 * Legacy lineage:
 * - run/enable_gadget.sh
 * - run/disable_gadget.sh
 */
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { CommandRunner, defaultCommandRunner } from '../shared/command-runner';
import { logger } from './logger';

export interface GadgetManagerPaths {
  backingFilesDir: string;
  machineIdPath: string;
  modelPath: string;
  configfsMountsPath: string;
  udcClassPath: string;
  procModulesPath: string;
}

export interface GadgetManagerOptions {
  gadgetName?: string;
  commandRunner?: CommandRunner;
  paths?: Partial<GadgetManagerPaths>;
}

const DEFAULT_PATHS: GadgetManagerPaths = {
  backingFilesDir: '/backingfiles',
  machineIdPath: '/etc/machine-id',
  modelPath: '/sys/firmware/devicetree/base/model',
  configfsMountsPath: '/proc/mounts',
  udcClassPath: '/sys/class/udc',
  procModulesPath: '/proc/modules',
};

export class GadgetManager {
  private readonly gadgetName: string;
  private readonly commandRunner: CommandRunner;
  private readonly paths: GadgetManagerPaths;

  constructor(options: GadgetManagerOptions = {}) {
    this.gadgetName = options.gadgetName ?? 'teslausb';
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.paths = {
      ...DEFAULT_PATHS,
      ...(options.paths ?? {}),
    };
  }

  async enable(): Promise<void> {
    const configfsRoot = await this.resolveConfigfsRoot();
    const gadgetRoot = join(configfsRoot, 'usb_gadget', this.gadgetName);

    if (existsSync(gadgetRoot)) {
      logger.debug({ gadgetRoot }, 'USB gadget already prepared');
      return;
    }

    await this.unloadLegacyGEtherIfPresent();

    await this.runCommand('modprobe', ['libcomposite']);

    const languageCode = '0x409';
    const configName = 'c';
    await mkdir(join(gadgetRoot, 'configs', `${configName}.1`), { recursive: true });

    await writeFile(join(gadgetRoot, 'idVendor'), '0x1d6b\n', 'utf-8');
    await writeFile(join(gadgetRoot, 'idProduct'), '0x0104\n', 'utf-8');
    await writeFile(join(gadgetRoot, 'bcdDevice'), '0x0100\n', 'utf-8');
    await writeFile(join(gadgetRoot, 'bcdUSB'), '0x0200\n', 'utf-8');

    await mkdir(join(gadgetRoot, 'strings', languageCode), { recursive: true });
    await mkdir(join(gadgetRoot, 'configs', `${configName}.1`, 'strings', languageCode), { recursive: true });

    const machineId = await this.readTrimmed(this.paths.machineIdPath);
    const serialHash = createHash('sha256').update(machineId).digest('hex');
    await writeFile(join(gadgetRoot, 'strings', languageCode, 'serialnumber'), `TeslaUSB-${serialHash}\n`, 'utf-8');
    await writeFile(join(gadgetRoot, 'strings', languageCode, 'manufacturer'), 'TeslaUSB\n', 'utf-8');
    await writeFile(join(gadgetRoot, 'strings', languageCode, 'product'), 'TeslaUSB Composite Gadget\n', 'utf-8');
    await writeFile(
      join(gadgetRoot, 'configs', `${configName}.1`, 'strings', languageCode, 'configuration'),
      'TeslaUSB Config\n',
      'utf-8',
    );

    const maxPower = await this.computeMaxPowerMilliAmps();
    await writeFile(join(gadgetRoot, 'configs', `${configName}.1`, 'MaxPower'), `${maxPower}\n`, 'utf-8');

    const massStorageRoot = join(gadgetRoot, 'functions', 'mass_storage.0');
    await mkdir(massStorageRoot, { recursive: true });

    const luns = await this.buildLuns();
    for (let index = 0; index < luns.length; index += 1) {
      const lunRoot = join(massStorageRoot, `lun.${index}`);
      await mkdir(lunRoot, { recursive: true });
      await writeFile(join(lunRoot, 'file'), `${luns[index].imagePath}\n`, 'utf-8');
      await writeFile(join(lunRoot, 'inquiry_string'), `${luns[index].inquiry}\n`, 'utf-8');
    }

    await symlink(massStorageRoot, join(gadgetRoot, 'configs', `${configName}.1`, 'mass_storage.0'));

    const udcName = await this.pickUdcName();
    await writeFile(join(gadgetRoot, 'UDC'), `${udcName}\n`, 'utf-8');
    logger.info({ udcName, luns: luns.length }, 'USB gadget enabled');
  }

  async disable(): Promise<void> {
    await this.runCommand('modprobe', ['-q', '-r', 'g_mass_storage'], true);

    const configfsRoot = await this.resolveConfigfsRoot();
    const gadgetRoot = join(configfsRoot, 'usb_gadget', this.gadgetName);

    if (!existsSync(gadgetRoot)) {
      logger.debug({ gadgetRoot }, 'USB gadget already released');
      return;
    }

    await writeFile(join(gadgetRoot, 'UDC'), '', 'utf-8').catch(() => undefined);
    await rm(join(gadgetRoot, 'configs'), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(gadgetRoot, 'functions'), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(gadgetRoot, 'strings'), { recursive: true, force: true }).catch(() => undefined);
    await rm(gadgetRoot, { recursive: true, force: true }).catch(() => undefined);

    await this.runCommand('modprobe', ['-r', 'usb_f_mass_storage', 'g_ether', 'usb_f_ecm', 'usb_f_rndis', 'libcomposite'], true);
    logger.info('USB gadget disabled');
  }

  private async runCommand(command: string, args: string[], ignoreFailure = false): Promise<void> {
    const result = await this.commandRunner.run(command, args);
    if (result.code === 0 || ignoreFailure) {
      return;
    }
    throw new Error(`${command} exited with ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  }

  private async unloadLegacyGEtherIfPresent(): Promise<void> {
    const modules = await readFile(this.paths.procModulesPath, 'utf-8').catch(() => '');
    if (!modules.match(/^g_ether\s/m)) {
      return;
    }

    logger.warn('Detected legacy g_ether module loaded; unloading before configfs gadget setup');
    await this.runCommand('modprobe', ['-r', 'g_ether']);
  }

  private async resolveConfigfsRoot(): Promise<string> {
    const mounts = await readFile(this.paths.configfsMountsPath, 'utf-8');
    const line = mounts
      .split(/\r?\n/)
      .find((entry) => entry.trim().length > 0 && entry.split(' ')[2] === 'configfs');

    if (!line) {
      throw new Error('configfs mount not found');
    }

    return line.split(' ')[1];
  }

  private async computeMaxPowerMilliAmps(): Promise<number> {
    const model = (await this.readTrimmed(this.paths.modelPath)).toLowerCase();
    if (model.includes('raspberry pi 5')) {
      return 600;
    }
    if (model.includes('raspberry pi 4')) {
      return 500;
    }
    if (model.includes('raspberry pi zero 2')) {
      return 200;
    }
    return 100;
  }

  private async buildLuns(): Promise<Array<{ imagePath: string; inquiry: string }>> {
    const images = [
      { fileName: 'cam_disk.bin', label: 'CAM' },
      { fileName: 'music_disk.bin', label: 'MUSIC' },
      { fileName: 'lightshow_disk.bin', label: 'LIGHTSHOW' },
      { fileName: 'boombox_disk.bin', label: 'BOOMBOX' },
    ];

    const luns: Array<{ imagePath: string; inquiry: string }> = [];

    for (const image of images) {
      const imagePath = join(this.paths.backingFilesDir, image.fileName);
      if (!existsSync(imagePath)) {
        continue;
      }

        const imageStats = await stat(imagePath);
        const sizeText = this.formatSize(imageStats.size);
      luns.push({
        imagePath,
        inquiry: `TeslaUSB ${image.label} ${sizeText}`,
      });
    }

    return luns;
  }

  private async pickUdcName(): Promise<string> {
    const entries = await readdir(this.paths.udcClassPath, { withFileTypes: true });
    const first = entries.find((entry) => entry.isDirectory() || entry.isSymbolicLink());
    if (!first) {
      throw new Error('No UDC found');
    }
    return first.name;
  }

  private async readTrimmed(path: string): Promise<string> {
    return (await readFile(path, 'utf-8')).trim();
  }

  private formatSize(sizeBytes: number): string {
    if (sizeBytes <= 0) {
      return '0B';
    }

    const units = ['B', 'K', 'M', 'G', 'T'];
    let unitIndex = 0;
    let value = sizeBytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
  }
}

export const gadgetManager = new GadgetManager();

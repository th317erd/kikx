import { CLI } from 'mythix';
import Path from 'node:path';

import { fileURLToPath }  from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

const {
  Commands: {
    DeployCommand,
  },
} = CLI;

export class ServerPrepCommand extends DeployCommand {
  static getCommandName() {
    return 'server-prep';
  }

  async prepRemoteTarget(target, deployConfig) {
    let app     = this.getApplication();
    let appName = app.getApplicationName();

    this.log(`Prepping remote "${target.uri.toString()}"...`);

    this.log('Running sudo apt update...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'apt', args: [ 'update' ] },
    ]);

    this.log('Installing nginx...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'which', args: [ 'nginx', '|| sudo apt install -y nginx' ] },
    ]);

    this.log('Installing build tools...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'which', args: [ 'make', '|| sudo apt install -y build-essential' ] },
    ]);

    this.log('Installing graphicsmagick...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'which', args: [ 'gm', '|| sudo apt install -y graphicsmagick libgraphicsmagick1-dev' ] },
    ]);

    this.log('Creating file structure...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'mkdir', args: [ '-p', `/var/log/${appName}` ] },
      { command: 'mkdir', args: [ '-p', `/opt/${appName}/shared` ] },
    ]);

    this.log('Installing NVM, Node, and latest NPM...');
    let nvmInstallScriptPath = Path.resolve(__dirname, '..', '..', 'system', 'install-node.sh');
    let remoteFileLocation = await this.copyFileToRemote(target, deployConfig, nvmInstallScriptPath);

    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'chmod', args: [ '+x', `"${remoteFileLocation}"` ] },
      { command: '/tmp/install-node.sh', args: [] },
    ]);

    this.log(`Copying service file "${appName}.service" to remote...`);
    let serviceFilePath = Path.resolve(__dirname, '..', '..', 'system', `${appName}.service`);
    remoteFileLocation = await this.copyFileToRemote(target, deployConfig, serviceFilePath);

    this.log('Setting up service file and restarting systemd...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'test', args: [ '!', '-f', `/etc/systemd/system/${appName}.service`, '&&', `{ sudo cp ${remoteFileLocation} /etc/systemd/system/${appName}.service; sudo rm -f ${remoteFileLocation}; sudo systemctl daemon-reload; } || true` ] },
    ]);

    this.log(`Copying logrotate file "${appName}.logrotate" to remote...`);
    let logRotateFilePath = Path.resolve(__dirname, '..', '..', 'system', `${appName}.logrotate`);
    remoteFileLocation = await this.copyFileToRemote(target, deployConfig, logRotateFilePath);

    this.log('Setting up log rotation file...');
    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'mkdir', args: [ '-p', '/etc/logrotate.d/' ] },
      { command: 'test', args: [ '!', '-f', `/etc/logrotate.d/${appName}`, '&&', `{ sudo cp ${remoteFileLocation} /etc/logrotate.d/${appName}; sudo rm -f ${remoteFileLocation}; sudo systemctl daemon-reload; } || true` ] },
    ]);

    this.log('Copying application entry point script to remote...');
    let scriptFilePath = Path.resolve(__dirname, '..', '..', 'system', 'run.sh');
    remoteFileLocation = await this.copyFileToRemote(target, deployConfig, scriptFilePath, {
      substituteContent: (content) => {
        return content.replace(/NODE_ENV="[\w-]+"/g, () => {
          return `NODE_ENV="${deployConfig.target}"`;
        });
      },
    });

    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'cp', args: [ `"${remoteFileLocation}"`, `/opt/${appName}/${appName}.sh` ] },
      { command: 'chmod', args: [ '+x', `/opt/${appName}/${appName}.sh` ] },
      { command: 'rm', args: [ '-f', `"${remoteFileLocation}"` ] },
    ]);

    this.log('Copying console entry point script to remote...');
    let consoleScriptFilePath = Path.resolve(__dirname, '..', '..', 'system', 'console.sh');
    remoteFileLocation = await this.copyFileToRemote(target, deployConfig, consoleScriptFilePath, {
      substituteContent: (content) => {
        return content.replace(/NODE_ENV="[\w-]+"/g, () => {
          return `NODE_ENV="${deployConfig.target}"`;
        });
      },
    });

    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'cp', args: [ `"${remoteFileLocation}"`, `/opt/${appName}/console.sh` ] },
      { command: 'chmod', args: [ '+x', `/opt/${appName}/console.sh` ] },
      { command: 'rm', args: [ '-f', `"${remoteFileLocation}"` ] },
      { command: 'chmod', args: [ '+x', `/opt/${appName}/${appName}.sh` ] },
      { command: 'chown', args: [ '-R', 'ubuntu:ubuntu', `/opt/${appName}` ] },
      { command: 'chown', args: [ '-R', 'ubuntu:ubuntu', `/var/log/${appName}` ] },
    ]);

    this.log('Copying NGINX site config to remote...');
    let nginxConfigFileName = `${deployConfig.target}.${appName}.conf`;
    let nginxConfigFile     = Path.resolve(__dirname, '..', '..', 'system', nginxConfigFileName);

    remoteFileLocation = await this.copyFileToRemote(target, deployConfig, nginxConfigFile);

    await this.executeRemoteCommands(target, deployConfig, [
      { command: 'cp', args: [ `"${remoteFileLocation}"`, '/etc/nginx/sites-available/' ] },
      { command: 'rm', args: [ '-f', `"${remoteFileLocation}"` ] },
      { command: 'rm', args: [ '-f', `"/etc/nginx/sites-enabled/${nginxConfigFileName}"` ] },
      { command: 'rm', args: [ '-f', '"/etc/nginx/sites-enabled/default"' ] },
      { command: 'ln', args: [ '-s', `"/etc/nginx/sites-available/${nginxConfigFileName}"`, `"/etc/nginx/sites-enabled/${nginxConfigFileName}"` ] },
    ]);

    this.log(`Server prep complete for "${target.uri.toString()}"!`);
  }

  async allRemotesPrep(deployConfig) {
    return await this.iterateDeployTargets(deployConfig, this.prepRemoteTarget.bind(this));
  }

  async execute(args) {
    let deployConfig;

    try {
      deployConfig = await this.loadDeployConfig(args);
    } catch (error) {
      console.error(error.message);
      return 1;
    }

    try {
      await this.allRemotesPrep(deployConfig);
    } catch (error) {
      console.error(error);
      return 1;
    }
  }
}

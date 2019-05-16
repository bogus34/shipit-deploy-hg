const path = require('path');
const fs = require('fs');
const shipitUtils = require('shipit-utils');
const moment = require('moment');
const mkdirp = require('mkdirp');
const { get, has, isEqual } = require('lodash');
const chalk = require('chalk');

/*****

   Directory structure:

   /deployTo
       |
       +- releases
       |   |
       |   +- last release
       |   +- previous release
       |   +- another one
       |
       +- current release symlink

****/

function logRunEmit(shipit, message, event, fn) {
    return async () => {
        if (!fn) {
            fn = event;
            event = null;
        }

        shipit.log(chalk.green(message));
        await fn();
        shipit.log(chalk.green('Done'));
        if (event) shipit.emit(event);
    };
}

function mkdir(path, opts) {
    return new Promise((resolve, reject) => {
        mkdirp(path, opts, (err, res) => {
            if (err) return reject(err);
            return resolve(res);
        });
    });
}

function getConfig(shipit, path, defaultVal) {
    if (has(shipit.config.deploy, path)) {
        return get(shipit.config.deploy, path, defaultVal);
    } else {
        return get(shipit.config, path, defaultVal);
    }
}

function getWorkspace(shipit) {
    const workspacePath = getConfig(shipit, 'workspace');
    if (path.isAbsolute(workspacePath)) {
        return workspacePath;
    } else {
        return path.resolve(__dirname, '..', workspacePath);
    }
}

function equalValues(values) {
  return values.every(value => isEqual(value, values[0]));
}

async function getCurrentReleaseDirname(shipit) {
    const deployTo = getConfig(shipit, 'deployTo');
    const currentPath = path.join(deployTo, 'current');

    const results =
          (await shipit.remote(
              `if [ -h '${currentPath}' ]; then readlink '${currentPath}'; fi`,
          )) || [];


    const releaseDirnames = results
          .map(({ stdout }) => stdout.trim());

    if (!equalValues(releaseDirnames)) {
        throw new Error('Remote servers are not synced.');
    }

    if (!releaseDirnames[0]) {
        return null;
    }

    return path.basename(path.resolve(deployTo, 'releases', releaseDirnames[0]));
}

async function getLocalRevision(shipit) {
    const workspacePath = getWorkspace(shipit);
    const { stdout: revision } = await shipit.local('hg id -i', { cwd: workspacePath });
    return revision.trim();
}

async function getAllReleases(shipit) {
    const deployTo = getConfig(shipit, 'deployTo');

    const lsResults = await shipit.remote(`ls -1 ${deployTo}/releases`);
    const allReleases = lsResults.map(({stdout}) => stdout.trim().split("\n").map((s) => s.trim()));
    if (!equalValues(allReleases)) {
        throw new Error('Remote servers are not synced');
    }
    return allReleases[0];
}

function checkConfigTask(shipit) {
    shipitUtils.registerTask(shipit, 'deploy:check-config', () => {
        const config = shipit.config.deploy;
        if (!config.repository) {
            throw new Error('no repository defined!');
        }
        if (!config.workspace) {
            throw new Error('no workspace defined!');
        }
        if (!config.deployTo) {
            throw new Error('no deployment path defined!');
        }
    });
}

function checkRemoteScript(deployTo) {
    return `
if [ -e ${deployTo} ]; then
  if [ ! -d ${deployTo} ]; then
    echo 'ERR: deploy dir exists and not a directory';
  else
    cd ${deployTo}
    [ -e upcoming ] && echo 'ERR: upcoming link already exists'
    [ -e current ] && [ ! -L current ] && echo 'ERR: current exists and not a symlink'
    [ -e releases] && [ ! -d releases ] && echo 'ERR: releases exists and not a directory'
  fi
fi
exit 0
`;
}

function checkRemoteTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:check-remote',
        logRunEmit(shipit, 'Check remote directories', async () => {
            const deployTo = getConfig(shipit, 'deployTo');

            const result = await shipit.remote(checkRemoteScript(deployTo));
            if (result) {
                const failed = result.find((r) => r.stdout && r.stdout.indexOf('ERR:') != -1);
                if (failed) {
                    throw new Error('Remote directory structure is not sane');
                }
            }
        })
    );
}

function createWorkspaceTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:create-workspace',
        logRunEmit(shipit, 'Creating and checking workspace', 'workspaceCreated',  async () => {
            const workspacePath = getWorkspace(shipit);
            const repository = getConfig(shipit, 'repository');

            let newWorkspace = false;
            try {
                const stat = fs.statSync(workspacePath);
                if (!stat.isDirectory()) {
                    throw new Error('workspace exists and is not a directory');
                }
            } catch (e) {
                if (e.code == 'ENOENT') {
                    newWorkspace = true;
                } else {
                    throw e;
                }
            }

            if (newWorkspace) {
                mkdirp(workspacePath);
                // hg init
                await shipit.local('hg init', { cwd: workspacePath });
                await shipit.local(`echo -e "[paths]\ndefault = ${repository}" > .hg/hgrc`, { cwd: workspacePath });
            } else {
                // check mercurial repo
                const { stdout: hgPath } = await shipit.local('hg paths default', { cwd: workspacePath });
                if (!hgPath || hgPath.trim() != repository) {
                    throw new Error("workspace default path doesn't match config.repository");
                }
            }
        })
    );
}

function fetchTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:fetch',
        logRunEmit(shipit, 'Fetching source', 'fetched', async () => {
            const workspacePath = getWorkspace(shipit);
            const revision = await getLocalRevision(shipit);

            if (revision.match(/\+$/)) {
                throw new Error("workspace isn't clean");
            }

            const bookmark = getConfig('bookmark', '');
            await shipit.local('hg pull', { cwd: workspacePath });
            await shipit.local(`hg update ${bookmark}`, { cwd: workspacePath });
        })
    );
}

function buildTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:build',
        logRunEmit(shipit, 'Building', 'built', async () => {
            const workspacePath = getWorkspace(shipit);
            const build = getConfig(shipit, 'build', []);

            if (!build.length) {
                shipit.log(chalk.yellow('No build commands supplied'));
            }

            for (const task of build) {
                await shipit.local(task, { cwd: workspacePath });
            }

            const revision = await getLocalRevision(shipit);
            if (revision.match(/\+$/)) {
                shipit.log(chalk.yellow('Warning: workspace gets dirty after building, it could lead to an error during next deploy'));
            }
        })
    );
}

function updateTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:update',
        logRunEmit(shipit, 'Updating remote sources', 'updated', async () => {
            const workspacePath = getWorkspace(shipit);
            const deployTo = getConfig(shipit, 'deployTo');
            const remoteCopyOptions = getConfig(shipit, 'remoteCopy', { rsync: '--del' });
            const dirsToCopy = getConfig(shipit, 'dirsToCopy', [workspacePath]);

            const currentRev = await getLocalRevision(shipit);
            const today = moment.utc().format('YYYYMMDDHHmmss');
            const nextReleasePath = path.join(deployTo, 'releases', `${today}-${currentRev.replace(/\+$/, '')}`);

            shipit.log(`Create next release dir: ${nextReleasePath}`);
            await shipit.remote(`mkdir -p ${nextReleasePath}`);

            const previousRelease = await getCurrentReleaseDirname(shipit);
            if (previousRelease) {
                shipit.log(`Copy previous release from ${previousRelease}`);
                await shipit.remote(`cp -r ${path.join(deployTo, 'releases', previousRelease)}/. ${nextReleasePath}`);
            } else {
                shipit.log('No previous release found');
            }

            shipit.log('Upload source');
            await Promise.all(dirsToCopy.map(async (dir) => {
                const srcDir = path.resolve(workspacePath, dir);
                const relativeSrc = path.relative(workspacePath, srcDir);
                const targetDir = path.resolve(nextReleasePath, relativeSrc, '..');
                await shipit.copyToRemote(srcDir, targetDir, remoteCopyOptions);
                shipit.log(`${dir} uploaded`);
            }));

            shipit.log('Create symlink');
            await shipit.remote(`ln -s ${nextReleasePath} ${path.join(deployTo, 'upcoming')}`);
        })
    );
}

function setupTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:setup',
        logRunEmit(shipit, 'Setting up deployment', 'setup', async () => {
            const deployTo = getConfig(shipit, 'deployTo');
            const setup = getConfig(shipit, 'setup', []);
            for (const task of setup) {
                await shipit.remote(`cd ${path.join(deployTo, 'upcoming')} && ${task}`);
            }
        })
    );
}

function publishTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:publish',
        logRunEmit(shipit, 'Publishing current release', 'published', async () => {
            const deployTo = getConfig(shipit, 'deployTo');
            const result = await shipit.remote(
                `cd ${deployTo} && mv -fT upcoming current`
            );
        })
    );
}

function restartTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:restart',
        logRunEmit(shipit, 'Restart', 'restarted', async () => {
            const workspacePath = getWorkspace(shipit);
            const restart = getConfig(shipit, 'restart', []);

            if (!restart.length) {
                shipit.log(chalk.yellow('No restart commands supplied'));
            }

            for (const task of restart) {
                await shipit.remote(task);
            }
        })
    );
}

function cleanupTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'deploy:cleanup',
        logRunEmit(shipit, 'Cleanup old releases', async () => {
            const deployTo = getConfig(shipit, 'deployTo');
            const releasesPath = path.join(deployTo, 'releases');
            const upcomingPath = path.join(deployTo, 'upcoming');
            const keepReleases = getConfig(shipit, 'keepReleases', 3);

            shipit.log(chalk.yellow('Removing upcoming release, if any'));

            try {
                await shipit.remote(`[ -h ${upcomingPath} ] && rm -rf $(readlink ${upcomingPath}) && rm ${upcomingPath}`);
            } catch (e) {
                // pass
            }

            const releases = await getAllReleases(shipit);
            if (releases.length <= keepReleases + 1) {
                return;
            }

            const dropReleases = releases.slice(0, releases.length - keepReleases - 1);
            shipit.log(chalk.red(`Dropping ${dropReleases}"`));

            const dropPaths = dropReleases.map((p) => path.join(releasesPath, p)).join(' ');
            await shipit.remote(`rm -rf ${dropPaths}`);
        })
    );
}

function rollbackPrepareTask(shipit) {
    shipitUtils.registerTask(
        shipit,
        'rollback:prepare',
        logRunEmit(shipit, 'Searching release for rollback', 'rollback', async () => {
            const deployTo = getConfig(shipit, 'deployTo');
            const currentRelease = await getCurrentReleaseDirname(shipit);
            if (!currentRelease) {
                throw new Error("Can't find current release");
            }

            const releases = await getAllReleases(shipit);
            if (releases.length < 2) {
                throw new Error("Can't find release for rollback");
            }

            shipit.log('Dist releases: %j.', releases);
            shipit.log('Current release: %s', currentRelease);

            const currentReleaseIndex = releases.indexOf(currentRelease);
            if (currentReleaseIndex < 1) {
                throw new Error("Can't find release for rollback");
            }
            const rollbackReleaseIndex = currentReleaseIndex - 1;
            const rollbackTo = releases[rollbackReleaseIndex];
            const nextReleasePath = path.join(deployTo, 'releases', rollbackTo);

            shipit.log(chalk.yellow(`Rolling back to ${nextReleasePath}`));
            await shipit.remote(`ln -s ${nextReleasePath} ${path.join(deployTo, 'upcoming')}`);
        })
    );
}

function deployTask(shipit) {
    shipitUtils.registerTask(shipit, 'deploy', [
        'deploy:check-config',
        'deploy:check-remote',
        'deploy:create-workspace',
        'deploy:fetch',
        'deploy:build',
        'deploy:update',
        'deploy:setup',
        'deploy:publish',
        'deploy:restart',
        'deploy:cleanup'
    ]);
}

function rollbackTask(shipit) {
    shipitUtils.registerTask(shipit, 'rollback', [
        'deploy:check-config',
        'deploy:check-remote',
        'rollback:prepare',
        'deploy:publish',
        'deploy:restart'
    ]);
}

function init(shipit) {
    checkConfigTask(shipit);
    checkRemoteTask(shipit);
    createWorkspaceTask(shipit);
    fetchTask(shipit);
    buildTask(shipit);
    updateTask(shipit);
    setupTask(shipit);
    publishTask(shipit);
    restartTask(shipit);
    cleanupTask(shipit);
    rollbackPrepareTask(shipit);
    deployTask(shipit);
    rollbackTask(shipit);
}

module.exports = {
    init,

    deployTask,
    rollbackTask,

    checkConfigTask,
    checkRemoteTask,
    createWorkspaceTask,
    fetchTask,
    buildTask,
    updateTask,
    setupTask,
    publishTask,
    restartTask,
    cleanupTask,
    rollbackPrepareTask,

    getConfig,
    getWorkspace
};

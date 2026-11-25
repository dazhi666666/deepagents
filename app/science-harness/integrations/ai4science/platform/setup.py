"""Prepare the source installation using existing frozen locks and the host's native system dependency."""
import json
import os
import pathlib
import shutil
import subprocess


def main():
    repo = pathlib.Path(__file__).resolve().parents[3]
    pnpm = shutil.which('pnpm.cmd' if os.name == 'nt' else 'pnpm')
    if pnpm is None:
        raise SystemExit('pnpm is required on PATH')
    commands = [
        [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts'],
        [pnpm, '--dir', 'integrations/ai4science', 'install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts'],
        [pnpm, 'run', 'build:native-system'],
        [pnpm, 'exec', 'tsc', '-b', 'integrations/ai4science/platform/tsconfig.json', '--pretty', 'false'],
    ]
    for command in commands:
        print(json.dumps({'command': command, 'cwd': str(repo)}), flush=True)
        subprocess.run(command, cwd=repo, check=True)
    print('Source installation ready. Install a management profile with platform/install.py.')


if __name__ == '__main__':
    main()

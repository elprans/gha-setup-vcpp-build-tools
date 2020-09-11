import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {StringDecoder} from 'string_decoder'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as io from '@actions/io'
import {ExecOptions} from '@actions/exec/lib/interfaces'

const IS_WINDOWS = process.platform === 'win32'
const VS_VERSION = core.getInput('vs-version') || 'latest'
const VSWHERE_PATH = core.getInput('vswhere-path')

// prettier-ignore
let VSWHERE_EXEC = [
  '-latest',
  '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath',
  '-products', '*'
].join(' ')
// if a specific version of VS is requested
if (VS_VERSION !== 'latest') {
  VSWHERE_EXEC += `-version "${VS_VERSION}"`
}

core.debug(`Execution arguments: ${VSWHERE_EXEC}`)

async function run(): Promise<void> {
  try {
    // exit if non Windows runner
    if (IS_WINDOWS === false) {
      core.setFailed('setup-msbuild can only be run on Windows runners')
      return
    }

    // check to see if we are using a specific path for vswhere
    let vswhereToolExe = ''

    if (VSWHERE_PATH) {
      // specified a path for vswhere, use it
      core.debug(`Using given vswhere-path: ${VSWHERE_PATH}`)
      vswhereToolExe = path.join(VSWHERE_PATH, 'vswhere.exe')
    } else {
      // check in PATH to see if it is there
      try {
        const vsWhereInPath: string = await io.which('vswhere', true)
        core.debug(`Found tool in PATH: ${vsWhereInPath}`)
        vswhereToolExe = vsWhereInPath
      } catch {
        // fall back to VS-installed path
        vswhereToolExe = path.join(
          process.env['ProgramFiles(x86)'] as string,
          'Microsoft Visual Studio\\Installer\\vswhere.exe'
        )
        core.debug(`Trying Visual Studio-installed path: ${vswhereToolExe}`)
      }
    }

    if (!fs.existsSync(vswhereToolExe)) {
      core.setFailed(
        'setup-msbuild requires the path to where vswhere.exe exists'
      )

      return
    }

    core.debug(`Full tool exe: ${vswhereToolExe}`)

    let foundVCVarsPath = ''
    const options: ExecOptions = {}
    options.listeners = {
      stdout: (data: Buffer) => {
        const installationPath = data.toString().trim()

        if (installationPath === '') {
          core.setFailed(
            'Could not locate suitable Visual Studio installation.'
          )
          return
        }

        core.debug(`Found VS installation path: ${installationPath}`)

        const vcvarsPath = path.join(
          installationPath,
          'VC\\Auxiliary\\Build\\vcvarsall.bat'
        )

        core.debug(`Checking for path: ${vcvarsPath}`)
        if (!fs.existsSync(vcvarsPath)) {
          core.setFailed(
            `Unable to locate vcvarsall.bat: ${vcvarsPath} does not exist`
          )
          return
        }

        foundVCVarsPath = vcvarsPath
      }
    }

    let exitCode = await exec.exec(
      `"${vswhereToolExe}" ${VSWHERE_EXEC}`,
      [],
      options
    )

    if (exitCode !== 0) {
      core.setFailed('Could not locate suitable Visual Studio installation.')
      return
    }

    if (!foundVCVarsPath) {
      return
    }

    const newEnvironment = new Map()
    let vcvarsErr = ''

    options.listeners = {
      stdout: (data: Buffer) => {
        const decoder = new StringDecoder('utf16le')
        const envBlock = decoder.write(data).trim()

        for (const line of envBlock.split(os.EOL)) {
          const [name, val] = line.split('=', 2)
          newEnvironment.set(name, val)
        }
      },

      stderr: (data: Buffer) => {
        vcvarsErr = data.toString()
      }
    }

    options.silent = true
    exitCode = await exec.exec(
      `cmd /u /c "${foundVCVarsPath}" x64 >nul && set`,
      [],
      options
    )

    if (exitCode !== 0 || newEnvironment.size === 0) {
      core.setFailed(
        `Could not call vcvarsall.bat or parse environment: ${vcvarsErr}`
      )
      return
    }

    for (const [key, value] of newEnvironment) {
      if (process.env[key] !== value) {
        core.exportVariable(key, value)
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()

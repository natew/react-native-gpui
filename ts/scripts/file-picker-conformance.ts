import { FilePicker } from '../src/apis'

const script = FilePicker._script({
    multiple: true,
    files: true,
    directories: true,
    prompt: 'Attach file',
})

assert(script.includes('$.NSOpenPanel.openPanel'), 'script should use NSOpenPanel')
assert(script.includes('panel.canChooseFiles = true'), 'script should allow files')
assert(script.includes('panel.canChooseDirectories = true'), 'script should allow directories')
assert(script.includes('panel.allowsMultipleSelection = true'), 'script should allow multiple selection')
assert(script.includes('Attach file'), 'script should include prompt')

const paths = FilePicker._parse('["/tmp/a.txt","/tmp/b.png"]\n')
assert(paths.length === 2 && paths[1] === '/tmp/b.png', 'parser should return selected paths')
assert(FilePicker._parse('[]\n').length === 0, 'parser should accept canceled empty selection')
assert(FilePicker._parse('["", 1, "/tmp/c"]\n').join(',') === '/tmp/c', 'parser should discard invalid path values')

console.log('FILE_PICKER_CONFORMANCE_PASS paths=2')

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        console.error(`FILE_PICKER_CONFORMANCE_FAIL ${message}`)
        process.exit(1)
    }
}

/**
 * Minimal generic-worklet-dispatch probe (plans/off-thread-reanimated.md): does a
 * bare `runOnUI(worklet)()` from the React runtime execute on the worklet/UI
 * runtime? Prints PROBE lines the runner greps. The worklet reads
 * __rngpuiUiRuntimeReady — only the ui-runtime bundle sets it, so it
 * discriminates which runtime executed the code. Also round-trips a closure
 * value and a runOnJS callback.
 */
import { useEffect } from 'react'
import { runOnJS, runOnUI } from 'react-native-worklets'
import { Text, View, render } from '../src/index'

function App() {
  useEffect(() => {
    const captured = 41
    const report = (where: string, sum: number) => {
      console.log(`PROBE worklet ran where=${where} sum=${sum}`)
      console.log('PROBE DONE')
    }
    console.log('PROBE dispatching')
    runOnUI(() => {
      'worklet'
      const where = (globalThis as { __rngpuiUiRuntimeReady?: boolean }).__rngpuiUiRuntimeReady
        ? 'ui'
        : 'react'
      console.log(`PROBE inner where=${where} captured=${captured}`)
      runOnJS(report)(where, captured + 1)
    })()
  }, [])

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>worklet dispatch probe</Text>
    </View>
  )
}

render(<App />, { title: 'worklet-dispatch-probe', width: 320, height: 200 })

// Refresh the feature setting while the navigation stays mounted.
export function observeAxMessengerStatus(fetchStatus, setStatus, timers = globalThis) {
  let active = true
  let sequence = 0
  let controller
  const refresh = async () => {
    controller?.abort()
    controller = new AbortController()
    const request = ++sequence
    let enabled = false
    try {
      const response = await fetchStatus(controller.signal)
      enabled = response.ok && (await response.json())?.enabled === true
    } catch {}
    if (active && request === sequence) setStatus(enabled)
  }
  void refresh()
  const interval = timers.setInterval(refresh, 5000)
  return () => { active = false; controller?.abort(); timers.clearInterval(interval) }
}

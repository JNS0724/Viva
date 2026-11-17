let sequence = 0
const timer = setInterval(() => process.send?.(++sequence), 20)
process.on('disconnect', () => { clearInterval(timer); process.exit(0) })

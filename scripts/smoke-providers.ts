import { getAdapter, getProvider } from '../src/providers/registry.js'
import chalk from 'chalk'

async function smokeProvider(providerId: string, apiKey: string, baseUrl?: string): Promise<{ success: boolean; model: string; duration: number; error?: string }> {
  const provider = getProvider(providerId)
  const adapter = getAdapter(providerId)
  const startTime = Date.now()

  try {
    const stream = adapter.queryStream({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: 'Say exactly "OK"' }],
      maxTokens: 10,
    }, {
      apiKey,
      baseUrl
    })

    let responseText = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        responseText += chunk.text
      }
    }

    const duration = Date.now() - startTime
    return {
      success: responseText.trim().length > 0,
      model: provider.defaultModel,
      duration,
    }
  } catch (err: any) {
    return {
      success: false,
      model: provider.defaultModel,
      duration: Date.now() - startTime,
      error: err.message || String(err),
    }
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n--- Starting Provider End-to-End Smoke Tests ---'))

  const providersToTest = [
    { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY', envBaseUrl: 'ANTHROPIC_BASE_URL' },
    { id: 'openai', envKey: 'OPENAI_API_KEY', envBaseUrl: 'OPENAI_BASE_URL' },
    { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', envBaseUrl: 'DEEPSEEK_BASE_URL' },
    { id: 'zhipu', envKey: 'ZHIPU_API_KEY', envBaseUrl: 'ZHIPU_BASE_URL' },
    { id: 'minimax', envKey: 'MINIMAX_API_KEY', envBaseUrl: 'MINIMAX_BASE_URL' }
  ]

  let testedCount = 0
  let passedCount = 0

  for (const item of providersToTest) {
    const apiKey = process.env[item.envKey]
    const baseUrl = process.env[item.envBaseUrl]

    if (!apiKey) {
      console.log(`  ${chalk.bold(item.id.padEnd(10))}: ${chalk.dim('SKIP (no API key configured)')}`)
      continue
    }

    testedCount++
    console.log(`  Testing ${chalk.bold(item.id)} using ${chalk.yellow(item.envKey)}...`)
    const result = await smokeProvider(item.id, apiKey, baseUrl)
    if (result.success) {
      passedCount++
      console.log(`  ${chalk.bold(item.id.padEnd(10))}: ${chalk.green('PASS')} (${result.model}, took ${result.duration}ms)`)
    } else {
      console.log(`  ${chalk.bold(item.id.padEnd(10))}: ${chalk.red('FAIL')} (error: ${result.error})`)
    }
  }

  console.log(chalk.bold.cyan('\n--- Smoke Test Summary ---'))
  console.log(`  Total Tested: ${testedCount}`)
  console.log(`  Passed:       ${passedCount}`)
  console.log(`  Failed:       ${testedCount - passedCount}`)
  console.log()

  if (testedCount > 0 && passedCount < testedCount) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

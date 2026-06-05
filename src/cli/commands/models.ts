import chalk from 'chalk'
import { Command } from 'commander'
import { inspectModelCapabilities, modelRegistry } from '../../providers/registry.js'

export function registerModelsCommand(program: Command): void {
  const modelsCmd = program.command('models').description('Inspect capability matrices for supported models')

  modelsCmd
    .command('list')
    .description('List all supported models and their capabilities')
    .action(() => {
      console.log(chalk.cyan.bold('\nSupported Models Capability Matrix:'))
      console.log('----------------------------------------------------')
      for (const model of modelRegistry) {
        const toolSupport = model.capabilities.toolCalling ? chalk.green('✓ tool-call') : chalk.red('✗ tool-call')
        const jsonSupport = model.capabilities.jsonOutput ? chalk.green('✓ json') : chalk.red('✗ json')
        const streamingSupport = model.capabilities.streaming ? chalk.green('✓ stream') : chalk.red('✗ stream')

        console.log(
          `${chalk.bold(model.id.padEnd(30))} | Context: ${String(model.contextWindow).padEnd(7)} | ${toolSupport} | ${jsonSupport} | ${streamingSupport}`
        )
      }
      console.log()
    })

  modelsCmd
    .command('inspect')
    .description('Inspect details of a specific model')
    .argument('<modelId>', 'Model ID')
    .action((modelId: string) => {
      let diagnostics
      try {
        diagnostics = inspectModelCapabilities(modelId)
      } catch (error) {
        console.error(chalk.red(`Error: Model "${modelId}" does not reference a registered provider.`))
        process.exit(1)
      }

      console.log(chalk.cyan.bold(`\nModel Details: ${diagnostics.modelName}`))
      console.log(`ID:                 ${diagnostics.modelId}`)
      console.log(`Provider:           ${diagnostics.providerName} (${diagnostics.providerId})`)
      console.log(`Adapter:            ${diagnostics.adapter}`)
      console.log(`Auth Mode:          ${diagnostics.authMode}`)
      console.log(`Registry Declared:  ${diagnostics.modelDeclared ? chalk.green('Yes') : chalk.yellow('No')}`)
      console.log(`Capability Source:  ${diagnostics.capabilitySource}`)
      console.log(`Context Window:     ${diagnostics.contextWindow} tokens`)
      console.log(`Default Max Tokens: ${diagnostics.defaultMaxTokens} tokens`)
      console.log('Capabilities:')
      console.log(`  Long Context:      ${diagnostics.suitability.longContext ? chalk.green('Yes') : chalk.yellow('No')}`)
      console.log(`  Tool Calling:      ${diagnostics.capabilities.toolCalling ? chalk.green('Yes') : chalk.red('No')}`)
      console.log(`  JSON Output:       ${diagnostics.capabilities.jsonOutput ? chalk.green('Yes') : chalk.red('No')}`)
      console.log(`  Structured Output: ${diagnostics.capabilities.structuredOutput ? chalk.green('Yes') : chalk.red('No')}`)
      console.log(`  Streaming:         ${diagnostics.capabilities.streaming ? chalk.green('Yes') : chalk.red('No')}`)
      console.log('AgentLoop Roles:')
      for (const role of ['planner', 'executor', 'critic', 'optimizer'] as const) {
        const suitability = diagnostics.suitability.agentLoopRoles[role]
        const status = suitability.suitable ? chalk.green('OK') : chalk.yellow(`Missing ${suitability.missingCapabilities.join(', ')}`)
        console.log(`  ${role.padEnd(9)} ${status}`)
      }
      if (diagnostics.capabilityWarning) {
        console.log(chalk.yellow(`Note: ${diagnostics.capabilityWarning}`))
      }
      console.log(chalk.gray('No automatic model switch or role recommendation is performed.'))
      console.log()
    })
}

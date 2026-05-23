import chalk from 'chalk'
import { Command } from 'commander'
import { modelRegistry } from '../../providers/registry.js'

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
      const model = modelRegistry.find(m => m.id === modelId)
      if (!model) {
        console.error(chalk.red(`Error: Model "${modelId}" not found in model registry.`))
        process.exit(1)
      }
      console.log(chalk.cyan.bold(`\nModel Details: ${model.name}`))
      console.log(`ID:             ${model.id}`)
      console.log(`Context Window: ${model.contextWindow} tokens`)
      console.log('Capabilities:')
      console.log(`  Tool Calling: ${model.capabilities.toolCalling ? chalk.green('Yes') : chalk.red('No')}`)
      console.log(`  JSON Output:  ${model.capabilities.jsonOutput ? chalk.green('Yes') : chalk.red('No')}`)
      console.log(`  Streaming:    ${model.capabilities.streaming ? chalk.green('Yes') : chalk.red('No')}`)
      console.log()
    })
}

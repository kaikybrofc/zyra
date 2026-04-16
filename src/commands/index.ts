import type { Command } from './types.js'
import {
  addCommand,
  banCommand,
  demoteCommand,
  descriptionCommand,
  ephemeralCommand,
  groupCommand,
  inviteCommand,
  kickCommand,
  lockCommand,
  promoteCommand,
  revokeInviteCommand,
  subjectCommand,
} from './admin.js'
import { createMenuCommand } from './menu.js'
import { pingCommand } from './ping.js'

/**
 * Mapa de todos os comandos disponíveis no sistema.
 * As chaves correspondem ao nome do comando e os valores ao objeto de definição Command.
 */
const commandRegistry: Record<string, Command> = {}
const menuCommand = createMenuCommand(() => commandRegistry)

Object.assign(commandRegistry, {
  [menuCommand.name]: menuCommand,
  [pingCommand.name]: pingCommand,
  [addCommand.name]: addCommand,
  [kickCommand.name]: kickCommand,
  [banCommand.name]: banCommand,
  [promoteCommand.name]: promoteCommand,
  [demoteCommand.name]: demoteCommand,
  [groupCommand.name]: groupCommand,
  [lockCommand.name]: lockCommand,
  [subjectCommand.name]: subjectCommand,
  [descriptionCommand.name]: descriptionCommand,
  [inviteCommand.name]: inviteCommand,
  [revokeInviteCommand.name]: revokeInviteCommand,
  [ephemeralCommand.name]: ephemeralCommand,
})

export const commands: Record<string, Command> = commandRegistry

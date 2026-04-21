import { Collection } from 'discord.js';
import { SlashCommand } from './types';
import verify from './verify';
import lookup from './lookup';
import watch from './watch';
import chart from './chart';

export const commandList: SlashCommand[] = [verify, lookup, watch, chart];

export function buildCommandCollection(): Collection<string, SlashCommand> {
  const collection = new Collection<string, SlashCommand>();
  for (const cmd of commandList) {
    collection.set(cmd.data.name, cmd);
  }
  return collection;
}

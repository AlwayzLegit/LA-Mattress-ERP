import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from './roles.js';
describe('chat receptionist access', () => {
  it('allows inbox triage without administration, export or customer access', () => {
    const role = SYSTEM_ROLES.find((role) => role.name === 'Chat Receptionist');
    expect(role?.permissions).toEqual(['chat.view_team', 'chat.reply', 'chat.assign']);
  });
});

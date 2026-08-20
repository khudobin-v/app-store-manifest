import { describe, expect, it } from 'vitest';
import { hashPassword, isValidLogin, verifyPassword } from './users';

describe('пароли', () => {
  it('верный пароль проходит проверку', async () => {
    const stored = await hashPassword('очень-длинный-пароль');
    const user = { login: 'x', role: 'publisher' as const, createdAt: '', ...stored };

    expect(await verifyPassword('очень-длинный-пароль', user)).toBe(true);
  });

  it('неверный пароль не проходит', async () => {
    const stored = await hashPassword('правильный-пароль');
    const user = { login: 'x', role: 'publisher' as const, createdAt: '', ...stored };

    expect(await verifyPassword('неправильный', user)).toBe(false);
  });

  it('соль у каждого своя, хеши одинаковых паролей различаются', async () => {
    const a = await hashPassword('одинаковый-пароль');
    const b = await hashPassword('одинаковый-пароль');

    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('пароль в открытом виде нигде не сохраняется', async () => {
    const stored = await hashPassword('секретная-фраза');

    expect(JSON.stringify(stored)).not.toContain('секретная-фраза');
  });
});

describe('логины', () => {
  it.each(['ivan', 'ivan.petrov', 'user_1', 'a-b'])('принимает %s', (login) => {
    expect(isValidLogin(login)).toBe(true);
  });

  it.each(['i', 'Ivan', 'иван', 'user name', '.leading', ''])('отклоняет %s', (login) => {
    expect(isValidLogin(login)).toBe(false);
  });
});

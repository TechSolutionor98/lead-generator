import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  primaryPhone,
  websiteDomain,
  dedupKey,
  isIndividual,
} from '../dedup.js';
import type { Lead } from '../types.js';

const lead = (over: Partial<Lead>): Lead => ({
  source: 'test',
  name: 'Test',
  city: 'Москва',
  collectedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('normalizePhone', () => {
  it('formats a domestic 8… number to +7…', () => {
    expect(normalizePhone('8 (495) 123-45-67')).toBe('+74951234567');
  });

  it('keeps a +7 number', () => {
    expect(normalizePhone('+7 495 123 45 67')).toBe('+74951234567');
  });

  it('adds country code to a bare 10-digit number', () => {
    expect(normalizePhone('4951234567')).toBe('+74951234567');
  });

  it('handles 7… without plus', () => {
    expect(normalizePhone('74951234567')).toBe('+74951234567');
  });

  it('strips punctuation and spaces', () => {
    expect(normalizePhone('+7.495.123.45.67')).toBe('+74951234567');
  });

  it('returns undefined for junk / too short', () => {
    expect(normalizePhone('12345')).toBeUndefined();
    expect(normalizePhone('hello')).toBeUndefined();
    expect(normalizePhone('')).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });

  it('returns undefined for an implausible length', () => {
    expect(normalizePhone('+7 495 123 45 67 89')).toBeUndefined();
  });
});

describe('primaryPhone', () => {
  it('normalizes only the first phone in a list', () => {
    expect(primaryPhone('8 495 123 45 67, 8 495 765 43 21')).toBe('+74951234567');
  });
});

describe('websiteDomain', () => {
  it('extracts and lowercases the host, dropping www', () => {
    expect(websiteDomain('https://WWW.Example.com/contacts')).toBe('example.com');
  });
  it('works without a scheme', () => {
    expect(websiteDomain('shop.example.ru/path?x=1')).toBe('shop.example.ru');
  });
  it('returns undefined for junk', () => {
    expect(websiteDomain('not a url')).toBeUndefined();
    expect(websiteDomain('')).toBeUndefined();
    expect(websiteDomain(undefined)).toBeUndefined();
  });
});

describe('dedupKey', () => {
  it('prefers phone over everything', () => {
    const a = lead({ phone: '8 495 123 45 67', website: 'a.ru', name: 'A' });
    const b = lead({ phone: '+7 (495) 123-45-67', website: 'b.ru', name: 'B' });
    expect(dedupKey(a)).toBe(dedupKey(b));
    expect(dedupKey(a)).toBe('tel:+74951234567');
  });

  it('falls back to website domain when no phone', () => {
    const a = lead({ website: 'https://www.shop.ru', name: 'Shop One' });
    const b = lead({ website: 'http://shop.ru/about', name: 'Shop Two' });
    expect(dedupKey(a)).toBe('web:shop.ru');
    expect(dedupKey(a)).toBe(dedupKey(b));
  });

  it('falls back to name+address when no phone or site', () => {
    const a = lead({ name: 'Компьютеры', address: 'ул. Ленина, 1' });
    const b = lead({ name: 'компьютеры', address: 'УЛ. Ленина, 1' });
    expect(dedupKey(a)).toBe(dedupKey(b));
    expect(dedupKey(a).startsWith('na:')).toBe(true);
  });
});

describe('isIndividual', () => {
  it('flags an ИП prefix', () => {
    expect(isIndividual(lead({ name: 'ИП Иванов И.И.' }))).toBe(true);
  });
  it('flags a bare personal name', () => {
    expect(isIndividual(lead({ name: 'Иван Петров' }))).toBe(true);
    expect(isIndividual(lead({ name: 'Петров Иван Сергеевич' }))).toBe(true);
  });
  it('does not flag organizations', () => {
    expect(isIndividual(lead({ name: 'ООО Компьютеры' }))).toBe(false);
    expect(isIndividual(lead({ name: 'Магазин Электроники' }))).toBe(false);
    expect(isIndividual(lead({ name: 'DNS Store' }))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { SqlTranslator, SqlTranslationError } from '../src/core/SqlTranslator.js';

const t = SqlTranslator.toPositional;

describe('SqlTranslator', () => {
  it('replaces a name with a ? and returns its value', () => {
    expect(t('SELECT * FROM courses WHERE id = :id', { id: 'c-1' })).toEqual({
      sql: 'SELECT * FROM courses WHERE id = ?',
      params: ['c-1'],
    });
  });

  it('returns values in SQL order, not object order', () => {
    const out = t('INSERT INTO courses (id, title) VALUES (:id, :title)', {
      title: 'Algebra',
      id: 'c-1',
    });
    expect(out.params).toEqual(['c-1', 'Algebra']);
  });

  it('repeats the value when the same name appears more than once', () => {
    const out = t('SELECT * FROM t WHERE a = :x OR b = :x', { x: 7 });
    expect(out).toEqual({ sql: 'SELECT * FROM t WHERE a = ? OR b = ?', params: [7, 7] });
  });

  it('silently ignores values the SQL does not use', () => {
    // extractParams() merges path + query + body: the object always carries
    // more keys than the query consumes.
    const out = t('SELECT * FROM courses WHERE id = :id', {
      id: 'c-1',
      page: 2,
      locale: 'en',
    });
    expect(out.params).toEqual(['c-1']);
  });

  it('accepts null as a value, without confusing it with a missing key', () => {
    expect(t('UPDATE t SET note = :note', { note: null }).params).toEqual([null]);
  });

  it('leaves a : untouched inside a single-quoted literal', () => {
    const sql = "SELECT * FROM t WHERE label = 'a:b' AND id = :id";
    expect(t(sql, { id: 1 })).toEqual({
      sql: "SELECT * FROM t WHERE label = 'a:b' AND id = ?",
      params: [1],
    });
  });

  it('handles a doubled quote without leaving the literal too early', () => {
    const sql = "SELECT 'it''s :x' , :y";
    expect(t(sql, { y: 2 })).toEqual({ sql: "SELECT 'it''s :x' , ?", params: [2] });
  });

  it('leaves a : untouched inside a double-quoted or bracketed identifier', () => {
    expect(t('SELECT "a:b", [c:d] FROM t WHERE id = :id', { id: 1 }).sql).toBe(
      'SELECT "a:b", [c:d] FROM t WHERE id = ?',
    );
  });

  it('leaves a : untouched inside a line comment', () => {
    const sql = 'SELECT 1 -- not a parameter :x\nWHERE id = :id';
    expect(t(sql, { id: 1 }).params).toEqual([1]);
  });

  it('leaves a : untouched inside a block comment', () => {
    const sql = 'SELECT /* :x here */ 1 WHERE id = :id';
    expect(t(sql, { id: 1 })).toEqual({
      sql: 'SELECT /* :x here */ 1 WHERE id = ?',
      params: [1],
    });
  });

  it('does not touch a double colon', () => {
    expect(t('SELECT a::text FROM t', {}).sql).toBe('SELECT a::text FROM t');
  });

  it('does not treat a : followed by a digit or space as a name', () => {
    expect(t('SELECT 12:30, a : b FROM t', {}).params).toEqual([]);
  });

  it('refuses a missing name, naming it and what was available', () => {
    expect(() => t('SELECT * FROM t WHERE id = :missing', { id: 1 })).toThrow(
      SqlTranslationError,
    );
    expect(() => t('SELECT * FROM t WHERE id = :missing', { id: 1 })).toThrow(
      /:missing[\s\S]*Available values: id/,
    );
  });

  it('refuses to mix an already-present ? with names', () => {
    expect(() => t('SELECT * FROM t WHERE a = ? AND b = :b', { b: 1 })).toThrow(
      /ambiguous/,
    );
  });

  it('refuses an unterminated literal rather than guessing where it ends', () => {
    expect(() => t("SELECT 'never closed", {})).toThrow(/[Uu]nterminated/);
    expect(() => t('SELECT [never closed', {})).toThrow(/[Uu]nterminated/);
  });

  it('is not tricked by a key inherited from the prototype', () => {
    // 'constructor' exists on every object: without an own-property check it
    // would pass for a supplied value and a function would get bound.
    expect(() => t('SELECT :constructor', {})).toThrow(SqlTranslationError);
  });
});

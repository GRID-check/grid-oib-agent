/**
 * `grid/no-restricted-syntax` stands in for ESLint's core rule, so the test is
 * that it reports what the core rule reported for the selectors this repo
 * configures, and nothing near them.
 */

import { RuleTester } from 'oxlint/plugins-dev'
import rule from './no-restricted-syntax.mjs'

const ruleTester = new RuleTester({
  eslintCompat: true,
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
})

const options = [
  { selector: "CallExpression[callee.property.name='rollback'][arguments.length=0]", message: 'rollback' },
  { selector: "Literal[value='23505']", message: 'sqlstate' },
  { selector: "CallExpression[callee.property.name='getTextContent']", message: 'getTextContent' },
]

// `RuleTester.run` declares its own suite, so it has to sit at the top level.
ruleTester.run('no-restricted-syntax', rule, {
  valid: [
    { code: 'git.rollback(savepoint)', options },
    { code: "const code = '23506'", options },
    { code: 'readPageTextItems(page)', options },
    // No options, no findings.
    { code: 'tx.rollback()', options: [] },
  ],
  invalid: [
    { code: 'tx.rollback()', options, errors: [{ message: 'rollback' }] },
    { code: "if (error.code === '23505') {}", options, errors: [{ message: 'sqlstate' }] },
    // esquery compares attribute values as strings, so the numeric spelling is
    // caught too — as it was under ESLint, which uses the same esquery.
    { code: 'if (error.code === 23505) {}', options, errors: [{ message: 'sqlstate' }] },
    { code: 'await page.getTextContent({})', options, errors: [{ message: 'getTextContent' }] },
  ],
})

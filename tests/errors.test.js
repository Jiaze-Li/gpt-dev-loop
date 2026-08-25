import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransportError,
  ChromeUnavailableError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
  UsageError,
  mapErrorToExitCode,
} from '../src/bridge/errors.js';

test('each transport error carries a distinct non-zero exit code', () => {
  const errors = [
    new TransportError('x'),
    new ChromeUnavailableError('x'),
    new LoginRequiredError('x'),
    new SelectorMismatchError('x'),
    new ResponseTimeoutError('x'),
    new ResponseExtractionError('x'),
    new UsageError('x'),
  ];
  for (const err of errors) {
    assert.ok(err.exitCode > 0, `${err.name} should have a non-zero exit code`);
  }
});

test('mapErrorToExitCode reads the error exit code', () => {
  assert.equal(mapErrorToExitCode(new LoginRequiredError('x')), 3);
});

test('mapErrorToExitCode defaults to 1 for unrecognized errors', () => {
  assert.equal(mapErrorToExitCode(new Error('plain')), 1);
  assert.equal(mapErrorToExitCode(undefined), 1);
});

/**
 * Type-level guard for the `witnesses` option. Witness modules declare their
 * sets as interfaces, which carry no index signature, and the option must take
 * one as it is.
 *
 * Imported by nothing and never run: `tsc -p tests/integrations`, part of
 * `yarn types`, compiles it against the built package.
 */
import type { DeployerOptions } from '@openzeppelin/compact-deployer/deployer';
import type { RunDeployOptions } from '@openzeppelin/compact-deployer/run-deploy';
import {
  type IPrivateCounterWitnesses,
  type PrivateCounterState,
  PrivateCounterWitnesses,
} from '../../fixtures/witnesses/PrivateCounter.witness.ts';

const fromInterface: IPrivateCounterWitnesses<unknown, PrivateCounterState> =
  PrivateCounterWitnesses();

const _deployer: DeployerOptions['witnesses'] = fromInterface;
const _runDeploy: RunDeployOptions['witnesses'] = fromInterface;

// @ts-expect-error a witness set is an object
const _notAnObject: DeployerOptions['witnesses'] = 'witnesses';

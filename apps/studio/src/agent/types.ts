/**
 * What the agent modules import.
 *
 * One re-export point so the plan checker and the runner cannot drift onto different copies of
 * these types, and so the assistant package's action vocabulary reaches the browser without the
 * browser importing the assistant package itself -- which holds the API key and must never be in
 * the bundle.
 */
export { partDefinition, splitTerminal } from '@robo-journey/parts';
export type { PartInstance, Project, Wire } from '@robo-journey/parts';
export type { AgentAction, AgentPlan } from '@robo-journey/parts';
export { describeAction, subjectOf } from '@robo-journey/parts';

import { buildDemo } from '../scripts/demo-builder'
import { buildNativeHelper } from '../scripts/build-native-helper'

export default async function globalSetup(): Promise<void> {
  await buildNativeHelper()
  await buildDemo()
}

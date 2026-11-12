import { Type, type Static } from 'typebox'

/** Tank groups of the Signal K specification (`tanks.<kind>.<id>`). */
export const TANK_KINDS = [
  'fuel',
  'freshWater',
  'wasteWater',
  'blackWater',
  'lubrication',
  'gas',
  'ballast',
  'liveWell',
  'baitWell'
] as const
export type TankKind = (typeof TANK_KINDS)[number]

/** Values the specification allows for `tanks.<kind>.<id>.type`. */
export const FLUID_TYPES = [
  'diesel',
  'petrol',
  'fresh water',
  'lpg',
  'greywater',
  'blackwater',
  'holding',
  'liveWell',
  'baitWell',
  'ballast',
  'rum'
] as const

export const SET_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$'

const CanSchema = Type.Object({
  name: Type.String({ title: 'Name', description: 'For example "Red 20 L"', default: 'Jerry can' }),
  capacity: Type.Number({ title: 'Capacity (litres)', exclusiveMinimum: 0, default: 20 }),
  count: Type.Optional(
    Type.Integer({
      title: 'Number of cans',
      description: 'How many identical cans of this kind the set has',
      minimum: 1,
      default: 1
    })
  )
})

const SetSchema = Type.Object({
  id: Type.String({
    title: 'Id',
    description:
      'Last part of the Signal K path: letters, digits and _, starting with a letter. "dieselCans" with kind "fuel" gives tanks.fuel.dieselCans',
    pattern: SET_ID_PATTERN
  }),
  name: Type.String({ title: 'Name', description: 'Shown in apps as the tank name, for example "Diesel jerry cans"' }),
  kind: Type.Enum([...TANK_KINDS], { title: 'Tank kind', default: 'fuel' }),
  fluid: Type.Optional(Type.Enum([...FLUID_TYPES], { title: 'Contents', description: 'Published as the tank type' })),
  cans: Type.Array(CanSchema, { title: 'Cans', minItems: 1 })
})

export const ConfigSchema = Type.Object({
  sets: Type.Array(SetSchema, {
    title: 'Sets of jerry cans',
    description: 'Each set appears in Signal K as one tank with its total capacity and current volume',
    default: []
  })
})

export type CanConfig = Static<typeof CanSchema>
export type SetConfig = Static<typeof SetSchema>
export type Config = Static<typeof ConfigSchema>

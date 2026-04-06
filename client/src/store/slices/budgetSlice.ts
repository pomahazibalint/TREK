import { budgetApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { BudgetItem, BudgetMember } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface BudgetSlice {
  loadBudgetItems: (tripId: number | string) => Promise<void>
  addBudgetItem: (tripId: number | string, data: Partial<BudgetItem>) => Promise<BudgetItem>
  updateBudgetItem: (tripId: number | string, id: number, data: Partial<BudgetItem>) => Promise<BudgetItem>
  deleteBudgetItem: (tripId: number | string, id: number) => Promise<void>
  setBudgetItemMemberOwed: (
    tripId: number | string,
    itemId: number,
    members: { user_id: number; amount_owed_ref: number }[],
    tip_ref: number,
  ) => Promise<{ members: BudgetMember[]; item: BudgetItem }>
  setBudgetItemMemberPayments: (
    tripId: number | string,
    itemId: number,
    payments: { user_id: number; amount_paid_ref: number }[],
  ) => Promise<{ members: BudgetMember[] }>
}

export const createBudgetSlice = (set: SetState, get: GetState): BudgetSlice => ({
  loadBudgetItems: async (tripId) => {
    try {
      const data = await budgetApi.list(tripId)
      set({ budgetItems: data.items })
    } catch (err: unknown) {
      console.error('Failed to load budget items:', err)
    }
  },

  addBudgetItem: async (tripId, data) => {
    try {
      const result = await budgetApi.create(tripId, data as Record<string, unknown>)
      set(state => ({ budgetItems: [...state.budgetItems, result.item] }))
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding budget item'))
    }
  },

  updateBudgetItem: async (tripId, id, data) => {
    try {
      const result = await budgetApi.update(tripId, id, data as Record<string, unknown>)
      set(state => ({
        budgetItems: state.budgetItems.map(item => item.id === id ? result.item : item)
      }))
      if (result.item.reservation_id && data.total_price !== undefined) {
        get().loadReservations(tripId)
      }
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating budget item'))
    }
  },

  deleteBudgetItem: async (tripId, id) => {
    const prev = get().budgetItems
    set(state => ({ budgetItems: state.budgetItems.filter(item => item.id !== id) }))
    try {
      await budgetApi.delete(tripId, id)
    } catch (err: unknown) {
      set({ budgetItems: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting budget item'))
    }
  },

  setBudgetItemMemberOwed: async (tripId, itemId, members, tip_ref) => {
    const result = await budgetApi.setMemberOwed(tripId, itemId, members, tip_ref)
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId ? { ...item, members: result.members, tip_ref: result.item.tip_ref } : item
      )
    }))
    return result
  },

  setBudgetItemMemberPayments: async (tripId, itemId, payments) => {
    const result = await budgetApi.setMemberPayments(tripId, itemId, payments)
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId ? { ...item, members: result.members } : item
      )
    }))
    return result
  },
})

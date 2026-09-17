/**
 * Category grouping for the Skills toolbox — pure, so the arrangement is tested
 * without rendering a card.
 *
 * One ordered pass, not two structures: the API already returns the categories in
 * toolbox order (platform first, then the org's own), and a skill carries only
 * its category's id. Groups follow the category order; uncategorized skills close
 * the list under a null category. Empty categories are dropped — an empty category is
 * the manager's business (that is where it is listed), not the reader's.
 */

import type { SkillCategoryListItem, SkillListItem } from '@/adapters/api/skills-client'

export interface CategoryGroup {
  /** The category, or null for the unsorted closers. */
  category: SkillCategoryListItem | null
  skills: SkillListItem[]
}

/** Group skills onto their categories, in category order, unsorted last. */
export function groupSkillsByCategory(
  skills: readonly SkillListItem[],
  categories: readonly SkillCategoryListItem[],
): CategoryGroup[] {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const groups = new Map<string | null, SkillListItem[]>()
  for (const skill of skills) {
    const key = skill.categoryId && byId.has(skill.categoryId) ? skill.categoryId : null
    const group = groups.get(key)
    if (group) group.push(skill)
    else groups.set(key, [skill])
  }
  // A category id the list no longer carries (deleted mid-session) reads as
  // unsorted rather than dropping the skill — the row still exists.
  const ordered: CategoryGroup[] = []
  for (const category of categories) {
    const members = groups.get(category.id)
    if (members && members.length > 0) ordered.push({ category, skills: members })
  }
  const unsorted = groups.get(null)
  if (unsorted && unsorted.length > 0) ordered.push({ category: null, skills: unsorted })
  return ordered
}

/** Whether a skill answers the toolbox search — name or description, case-folded. */
export function matchesSkillQuery(skill: SkillListItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    skill.name.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  )
}

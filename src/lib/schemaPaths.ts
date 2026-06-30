import path from 'path'

const GITHUB_ROOT = 'C:\\Users\\richa\\github'

//----------------------------------------------------------------------------------
//  schemaFilePath — resolves scripts/schema.sql for a project by its connection key
//  Convention: every project stores its schema at scripts/schema.sql
//----------------------------------------------------------------------------------
export function schemaFilePath(projectKey: string): string {
  const result = path.join(GITHUB_ROOT, projectKey, 'scripts', 'schema.sql')
  return result
}

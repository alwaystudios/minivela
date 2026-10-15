export function projectRetrieveValues(project: string): string[] {
  const id = project.trim();
  if (!id) {
    throw new Error('project is required');
  }
  if (id === 'global') {
    return ['global'];
  }
  return [id, 'global'];
}

export function projectRetrieveFilter(project: string): {
  in: { key: 'project'; value: string[] };
} {
  return { in: { key: 'project', value: projectRetrieveValues(project) } };
}

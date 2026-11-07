// Where pipeline jobs can run. The label goes into the repo variable FACTORY_RUNS_ON, which every job uses.
export const RUNNER_CHOICES = [
  { label: 'ubuntu-latest', name: 'GitHub free runner', about: 'A fresh GitHub machine per job. Free for public repos; limited minutes for private ones.' },
  { label: 'instabox-medium', name: 'instabox (4 CPU, 8 GB)', about: 'A fresh instabox VM per job, deleted afterwards. Needs the instabox GitHub App linked to your workspace.' },
  { label: 'factory', name: 'Own machine', about: 'Your own server or VM, registered as a self-hosted runner with the label "factory".' },
] as const

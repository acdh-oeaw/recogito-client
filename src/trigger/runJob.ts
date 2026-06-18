import { getJob, updateJob } from '@backend/crud/jobs';
import { createClient } from '@supabase/supabase-js';
import { logger, task, tasks } from '@trigger.dev/sdk/v3';
import type { exportProject } from '@trigger/exportProject';
import type { importProject } from '@trigger/importProject';

interface Payload {
  jobId: string;
  projectId?: string;
  token: string;
  publicSupabaseUrl: string;
  publicSupabaseApiKey: string;
  iiifProjectId: string;
  iiifUrl: string;
  vaultTenantPath?: string;
}

const TASK_EXPORT = 'export-project';
const TASK_IMPORT = 'import-project';

export const runJob = task({
  id: 'run-job',
  run: async (payload: Payload) => {

    logger.info('================ RUN-JOB START ================');
    logger.info('RUN-JOB PAYLOAD');
    logger.info(JSON.stringify(payload, null, 2));

    const { publicSupabaseUrl, publicSupabaseApiKey } = payload;

    logger.info(`publicSupabaseUrl=${publicSupabaseUrl}`);
    logger.info(`publicSupabaseApiKey present=${!!publicSupabaseApiKey}`);

    if (!(publicSupabaseUrl && publicSupabaseApiKey)) {
      logger.error('Invalid Supabase credentials');
      logger.error(JSON.stringify({
        publicSupabaseUrl,
        publicSupabaseApiKeyPresent: !!publicSupabaseApiKey,
      }));
      return;
    }

    const { jobId, token, ...rest } = payload;

    logger.info(`jobId=${jobId}`);
    logger.info(`token present=${!!token}`);

    const supabase = createClient(publicSupabaseUrl, publicSupabaseApiKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    logger.info('Supabase client created');

    const jobResp = await getJob(supabase, jobId);

    logger.info('Job lookup completed');

    if (jobResp.error) {
      logger.error(jobResp.error.message);
      return;
    }

    logger.info(`job_type=${jobResp.data.job_type}`);

    let task: 'import-project' | 'export-project' | null;

    if (jobResp.data.job_type === 'EXPORT') {
      task = TASK_EXPORT;
    } else if (jobResp.data.job_type === 'IMPORT') {
      task = TASK_IMPORT;
    } else {
      task = null;
    }

    if (!task) {
      logger.error(
        `Unable to find task for job_type: ${jobResp.data.job_type}`
      );
      return;
    }

    logger.info(`Selected task=${task}`);

    // Update the job status
    await updateJob(supabase, { id: jobId, job_status: 'PROCESSING' });

    logger.info('Job status updated to PROCESSING');

    logger.info('CHILD TASK PAYLOAD');
    logger.info(
      JSON.stringify(
        {
          token,
          jobId,
          ...rest,
        },
        null,
        2
      )
    );

    // Run the job
    const result = await tasks.triggerAndWait<
      typeof exportProject | typeof importProject
    >(task, {
      token,
      jobId,
      ...rest,
    });

    logger.info(`Child task completed. ok=${result.ok}`);

    // Update the job status based on the result
    if (result.ok) {
      logger.info('Updating job status to COMPLETE');
      await updateJob(supabase, { id: jobId, job_status: 'COMPLETE' });
    } else {
      logger.info('Updating job status to ERROR');
      await updateJob(supabase, { id: jobId, job_status: 'ERROR' });
    }

    logger.info('================ RUN-JOB END ================');
  },
});

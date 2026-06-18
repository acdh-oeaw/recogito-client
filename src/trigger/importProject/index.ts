import { updateDocumentMetadata } from '@backend/crud';
import { getDownloadURL } from '@backend/storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger, task } from '@trigger.dev/sdk/v3';
import { generatePassword } from '@util/auth';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import * as sdk from '@1password/sdk';

interface Payload {
  jobId: string;
  token: string;
  publicSupabaseUrl: string;
  publicSupabaseApiKey: string;
  iiifProjectId: string;
  iiifUrl: string;
  vaultTenantPath?: string;
}

const DOCUMENTS_PREFIX = 'documents/';
const JSON_EXTENSION = '.json';

const PASSWORD_LENGTH = 14;

const getSecrets = async (vaultTenantPath?: string) => {
  // allow multi-tenant setup with 1password service account and vault path
  const isMultiTenant =
    process.env.MULTI_TENANT === 'true' && process.env.OP_SERVICE_ACCOUNT_TOKEN;

  if (!isMultiTenant || !vaultTenantPath) {
    // otherwise just use env vars
    return {
      IIIF_KEY: process.env.IIIF_KEY || '',
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    };
  }
  const client = await sdk.createClient({
    auth: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
    integrationName: 'Trigger.dev import-export multi-tenant',
    integrationVersion: '1.0.0',
  });
  const IIIF_KEY = await client.secrets.resolve(
    `op://${vaultTenantPath}/IIIF_KEY`
  );
  const SUPABASE_SERVICE_KEY = await client.secrets.resolve(
    `op://${vaultTenantPath}/SUPABASE_SERVICE_KEY`
  );
  return { IIIF_KEY, SUPABASE_SERVICE_KEY };
};

const createDocuments = async (
  supabase: SupabaseClient,
  importId: string,
  zip: AdmZip,
  iiifProjectId: string,
  iiifUrl: string,
  iiifKey: string,
) => {
  const zipEntries = zip.getEntries();

  for (const zipEntry of zipEntries) {
    const { entryName } = zipEntry;

    if (entryName.startsWith(DOCUMENTS_PREFIX)) {
      logger.info(`Uploading document ${ entryName }`);

      const documentId = entryName.replace(DOCUMENTS_PREFIX, '');

      const { data } = await supabase
        .schema('etl')
        .from('z_documents')
        .select('id, name, bucket_id, meta_data')
        .eq('legacy_id', documentId)
        .eq('is_new', true)
        .eq('import_id', importId)
        .maybeSingle();

      const {
        id,
        name,
        bucket_id: bucketId,
        meta_data: metadata = {}
      } = data || {};

      const file = zip.readFile(zipEntry);

      if (file) {
        if (id && bucketId) {
          logger.info(`Uploading file: ${ id }`);

          const { data, error } = await uploadFile(supabase, id, file);

          if (error) {
            logger.error(`Error uploading file: ${id}`);
            logger.error(error.message);
          } else {
            logger.info(`Successfully uploaded file: ${id}`);
            logger.info(data?.path);
          }

        } else if (id && metadata?.protocol === 'IIIF_IMAGE') {
          logger.info(`Uploading image: ${id}`);

          const { resource } = await uploadImage(name, file, iiifProjectId, iiifUrl, iiifKey);
          const url = resource.content_iiif_url.replace('full/max/0/default.jpg', 'info.json');

          const { data, error } = await updateDocumentMetadata(supabase, id, name, { ...metadata, url });

          if (error) {
            logger.error(`Error uploading image: ${id}`);
            logger.error(error.message);
          } else {
            logger.info(`Successfully uploaded image: ${id}`);
            logger.info(data?.id);
          }
        } else {
          logger.info(`Skipping upload for document ${ entryName }`);
        }
      }
    }
  }
};

const createUsers = async (
  supabase: SupabaseClient,
  importId: string,
  publicSupabaseUrl: string,
  supabaseServiceKey: string,
) => {
  if (!(publicSupabaseUrl && supabaseServiceKey)) {
    logger.error('Invalid admin credentials');
    return;
  }

  const { data: profiles } = await supabase
    .schema('etl')
    .from('z_profiles')
    .select('email')
    .eq('import_id', importId)
    .eq('is_new', true);

  if (profiles) {
    // Import jobs can only ever be run by an org admin user, so we'll use the service key to create the user
    const supa = await createClient(publicSupabaseUrl, supabaseServiceKey);

    for (const profile of profiles) {
      const { error } = await supa.auth.admin.createUser({
        email: profile.email,
        password: generatePassword(PASSWORD_LENGTH)
      });
      if (error && !error.message.includes('already exists')) {
        throw new Error(`Creation failed for user ${profile.email}: ${error.message}`);
      } else if (error) {
        logger.warn(`Skipping creation for user ${profile.email}`);
      }
    }
  }
};

const extract = async (
  supabase: SupabaseClient,
  importId: string,
  zip: AdmZip
) => {
  const zipEntries = zip.getEntries();

  for (const zipEntry of zipEntries) {
    const { entryName } = zipEntry;

    if (entryName.endsWith(JSON_EXTENSION)) {
      logger.info(`Extracting ${entryName}`);

      const content = zip.readAsText(entryName);
      const records = getRecords(importId, entryName, content);
      const tableName = `z_${entryName.replace(JSON_EXTENSION, '')}`;

      const { error } = await supabase
        .schema('etl')
        .from(tableName)
        .insert(records);

      if (error) {
        throw new Error(`Error inserting into ${tableName}: ${error.message}`);
      } else {
        logger.info(`Successfully inserted ${records.length} records into ${tableName}`);
      }
    }
  }
};

const getRecords = (
  importId: string,
  entryName: string,
  content: string
) => {
  let records;

  try {
    const items = JSON.parse(content);
    records = items?.map((item: any) => {
      // pull old ID, generated columns out of exported data
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, collection_document_id, revision_number, ...rest } = item;

      return {
        legacy_id: id,
        import_id: importId,
        ...rest
      };
    });
  } catch (e) {
    throw new Error(`Malformed JSON in ${entryName}: ${(e as Error).message}`);
  }

  return records;
};

const load = async (
  supabase: SupabaseClient,
  importId: string
) => {
  const { data: success, error } = await supabase
    .schema('etl')
    .rpc('load_rpc', { _import_id: importId });

  if (error) {
    throw new Error(`Error loading data: ${importId}: ${error.code} - ${error.details} - ${error.message}`);
  } else if (!success) {
    throw new Error('Unauthorized');
  } else {
    logger.info(`Successfully loaded data: ${importId}`);
  }
};

const transform = async (
  supabase: SupabaseClient,
  importId: string
) => {
  const { error } = await supabase
    .schema('etl')
    .rpc('transform_rpc', { _import_id: importId });

  if (error) {
    throw new Error(`Error transforming data: ${importId}: ${error.code} - ${error.details} - ${error.message}`);
  } else {
    logger.info(`Successfully transformed data: ${importId}`);
  }
};

const uploadFile = async (
  supabase: SupabaseClient,
  name: string,
  file: Buffer
) =>
  supabase
    .storage
    .from('documents')
    .upload(name, file)

const uploadImage = async (
  name: string,
  buffer: Buffer,
  iiifProjectId: string,
  iiifUrl: string,
  iiifKey: string,
) => {
  if (!(iiifProjectId && iiifUrl && iiifKey)) {
    logger.error('Invalid IIIF credentials');
    return;
  }

  const data = new Uint8Array(buffer).buffer;
  const file = new File([data], name);

  // Forward as outgoing FormData
  const formData = new FormData();
  formData.append('resource[name]', name);
  formData.append('resource[project_id]', iiifProjectId);
  formData.append('resource[content]', file);

  const response = await fetch(iiifUrl, {
    body: formData,
    headers: {
      'X-API-KEY': iiifKey,
    },
    method: 'POST'
  });

  return response.json();
};

export const importProject = task({
  id: 'import-project',
run: async (payload: Payload) => {

  logger.info('================ IMPORT START ================');
  logger.info('Payload received');
  logger.info(JSON.stringify(payload, null, 2));

  const {
    jobId,
    token,
    publicSupabaseUrl,
    publicSupabaseApiKey,
    iiifProjectId,
    iiifUrl,
    vaultTenantPath,
  } = payload;

  logger.info(`jobId=${jobId}`);
  logger.info(`token present=${!!token}`);
  logger.info(`publicSupabaseUrl=${publicSupabaseUrl}`);
  logger.info(`publicSupabaseApiKey present=${!!publicSupabaseApiKey}`);
  logger.info(`iiifProjectId=${iiifProjectId}`);
  logger.info(`iiifUrl=${iiifUrl}`);
  logger.info(`vaultTenantPath=${vaultTenantPath}`);

  if (!(publicSupabaseUrl && publicSupabaseApiKey)) {
    logger.error('Invalid Supabase credentials');
    logger.error(JSON.stringify({
      publicSupabaseUrl,
      publicSupabaseApiKeyPresent: !!publicSupabaseApiKey,
    }));
    return;
  }

  const importId = uuidv4();
  logger.info(`Generating import ID: ${importId}`);

  logger.info('Creating Supabase client');

  const supabase = createClient(publicSupabaseUrl, publicSupabaseApiKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      }
    }
  });

  logger.info('Supabase client created');

  logger.info('Downloading ZIP URL');
  const url = await getDownloadURL(supabase, jobId, 'jobs');
  logger.info(`ZIP URL obtained: ${url}`);

  logger.info('Downloading ZIP file');
  const fileResp = await fetch(url);
  logger.info(`ZIP response status=${fileResp.status}`);

  const buffer = await fileResp.arrayBuffer();
  logger.info(`ZIP size=${buffer.byteLength}`);

  const zip = new AdmZip(Buffer.from(buffer));

  logger.info('Extract phase starting');

  await extract(supabase, importId, zip);

  logger.info('Extract phase completed');

  await transform(supabase, importId);

  logger.info('Transform phase completed');

  const { IIIF_KEY, SUPABASE_SERVICE_KEY } = await getSecrets(vaultTenantPath);

  logger.info('Secrets loaded');
  logger.info(`IIIF_KEY present=${!!IIIF_KEY}`);
  logger.info(`SUPABASE_SERVICE_KEY present=${!!SUPABASE_SERVICE_KEY}`);

  await createUsers(
    supabase,
    importId,
    publicSupabaseUrl,
    SUPABASE_SERVICE_KEY
  );

  logger.info('Users phase completed');

  await load(supabase, importId);

  logger.info('Load phase completed');

  await createDocuments(
    supabase,
    importId,
    zip,
    iiifProjectId,
    iiifUrl,
    IIIF_KEY
  );

  logger.info('Documents phase completed');

  logger.info(`Completed import: ${importId}`);
}
});

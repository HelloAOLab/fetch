
import {join} from 'path'
import {existsSync, mkdirSync, writeFileSync} from 'fs'

import {parse as csv_parse} from 'csv-parse/sync'

import {request, concurrent} from '../parts/utils.js'
import {LICENSES, detect_year} from '../parts/license.js'
import {get_language_data} from '../parts/languages.js'
import type {TranslationSourceMeta} from '../parts/types'


interface EbibleRow {
    translationId:string
    FCBHID:string
    title:string
    description:string
    shortTitle:string
    languageCode:string
    textDirection:string
    Copyright:string
    UpdateDate:string
    swordName:string
}


export async function discover():Promise<void>{
    // Discover translations that are available

    // Parse eBible CSV to get translations list and useful metadata
    const csv_buffer =
        await request('https://ebible.org/Scriptures/translations.csv', 'arrayBuffer')
    const rows = csv_parse(Buffer.from(csv_buffer), {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as EbibleRow[]

    // Load language data
    const language_data = get_language_data()

    // Add each translation in the CSV file
    // Do concurrently since each involves a network request
    await concurrent(rows.map(row => async () => {

        // Determine ids etc
        const ebible_id = row['translationId']
        const lang_code = language_data.normalise(row['languageCode'])
        const trans_abbr = row['FCBHID'].slice(3).toLowerCase()
        const trans_id = `${lang_code!}_${trans_abbr}`
        const log_ids = `${trans_id}/${ebible_id}`

        // Warn if invalid language
        if (!lang_code){
            console.error(`IGNORED ${log_ids} (unknown language)`)
            return
        }

        // Skip if already discovered
        const trans_dir = join('sources', trans_id)
        const meta_file = join(trans_dir, 'meta.json')
        if (existsSync(meta_file)){
            console.info(`EXISTS ${log_ids}`)
            return
        }

        // Get translation's details page to see what data formats are available
        const ebible_url = `https://ebible.org/Scriptures/details.php?id=${ebible_id}`
        const page_resp = await request(ebible_url, 'text')

        // Detect source format and url
        let source_format:'usfm'|'sword' = 'usfm'
        let source_url = `https://ebible.org/Scriptures/${ebible_id}_usfm.zip`
        if (page_resp.includes('usfm.zip')){
            // USFM
        } else {
            const sword_url = /['"]https:\/\/ebible\.org\/sword\/.+\.zip['"]/i.exec(page_resp)?.[0]
            if (sword_url){
                source_format = 'sword'
                source_url = sword_url
            } else {
                console.warn(`IGNORED ${log_ids} (no suitable format)`)
                return
            }
        }
        console.info(`ADDING ${log_ids}`)

        // Detect the license
        let license:string|null = null
        let license_url = ebible_url
        const cc_url = /creativecommons.org\/licenses\/([a-z-]+)\/(\d+\.\d+)/i.exec(page_resp)
        if (cc_url){
            license = `cc-${cc_url[1]!}`
            if (license in LICENSES){
                license_url = `https://creativecommons.org/licenses/${cc_url[1]!}/${cc_url[2]!}/`
            } else {
                console.error(`Failed to detect CC license: ${license}`)
                license = null
            }
        } else if (/public domain/i.test(page_resp)){
            license = 'public'
        }

        // Prepare the meta data
        const meta:TranslationSourceMeta = {
            name: {
                autonym: row['title'],  // TODO Often in English (should be native)
                abbrev: trans_abbr.toUpperCase(),  // TODO Often in English (should be native)
                english: row['title'],  // TODO Sometimes not in English (should be English)
            },
            language: lang_code,
            year: detect_year(row['title'], row['shortTitle'], row['translationId'],
                row['swordName'], row['Copyright'], row['description']),
            direction: row['textDirection'] === 'rtl' ? 'rtl' : 'ltr',
            copyright: {
                licenses: license ? [{license, url: license_url}] : [],
                attribution: row['Copyright'],
                attribution_url: ebible_url,
            },
            audio: [],
            video: [],
            source: {
                service: 'ebible',
                id: ebible_id,
                format: source_format,
                url: source_url,
                updated: row['UpdateDate'],
            },
            obsoleted_by: null,
            reviewed: false,
        }

        // Save meta file
        mkdirSync(trans_dir, {recursive: true})
        writeFileSync(meta_file, JSON.stringify(meta))
    }))
}


// Generic method is compatible with this service's source format
export {generic_update_sources as update_sources} from './generic.js'

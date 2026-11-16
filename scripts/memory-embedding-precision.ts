/** Same-revision q8/FP32 diagnostic, using local artifacts only. Not a validation gate. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,statSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {evaluationDocuments} from '../test/fixtures/memory-file-evaluation.ts'
import {checkEvaluationFreeze,dataPolicy} from './memory-file-evaluation.ts'
import {openMemoryFileIndex} from '../src/memory/node/memory-file-index.ts'
import {createMemoryFileRetrieval} from '../src/memory/core/memory-file-retrieval.ts'
type Tensor={dims:number[],data:Float32Array}
type Extractor={
 (texts:string[],options:{pooling:'mean',normalize:true}):Promise<Tensor>;
 tokenizer:{encode(text:string):number[]}; dispose():Promise<void>
}
type Library={env:{allowRemoteModels:boolean,useFSCache:boolean,useBrowserCache:boolean};pipeline(task:'feature-extraction',model:string,options:{dtype:'q8'|'fp32',device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:number,interOpNumThreads:number}}):Promise<Extractor>}
type Case={id:string,mode:string,query:string,target:string,rawShortCorpus:{count:number,rank:number|null,score:number}}
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex')
const [q8Root, fp32Root, runtimeRoot, diagnosisPath, modelCardPath, outputPath] = process.argv.slice(2)
if (!q8Root || !fp32Root || !runtimeRoot || !diagnosisPath || !modelCardPath || !outputPath) {
 throw new Error('Required: q8 model, fp32 model, runtime, usage diagnosis JSON, official model card, output JSON')
}
const fp32Sha=hash(readFileSync(fp32Root+'/onnx/model.onnx'))
assert.equal(statSync(fp32Root+'/onnx/model.onnx').size,470268533)
assert.equal(fp32Sha,'4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff')
assert.equal(hash(readFileSync(q8Root+'/onnx/model_quantized.onnx')),'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193')
const freeze=checkEvaluationFreeze()
const db=new DatabaseSync(':memory:')
const index=openMemoryFileIndex({db})
const {policy,ids}=dataPolicy(evaluationDocuments)
const workspace=hash('holdout-workspace:public')
const retrieval=createMemoryFileRetrieval({index,policy,workspaces:()=>[workspace],hash})
retrieval.sync()
const files=index.files([workspace])
const short=evaluationDocuments.filter(doc=>doc.scope==='public'&&doc.state==='active'&&doc.body.length<=1100&&files.some(file=>ids.get(file.id)===doc.id))
const prior=JSON.parse(readFileSync(diagnosisPath,'utf8')) as {results:Case[]}
const cases=prior.results.filter(row=>['cross-3','cross-5','cross-7','cross-9'].includes(row.id))
assert.equal(cases.length,12); assert.equal(short.length,107)
const card=readFileSync(modelCardPath,'utf8')
const baseline=card.match(/input_texts = (\[[\s\S]+?\])\n/)?.[1]
assert.ok(baseline)
// Four quoted Python string literals from the official model-card example, without eval.
const baselineInputs=[...baseline.matchAll(/'([^']*)'|"([^"]*)"/g)].map(match=>match[1]??match[2]!)
assert.equal(baselineInputs.length,4)
const entry=createRequire(runtimeRoot+'/package.json').resolve('@huggingface/transformers')
const library=await import(pathToFileURL(entry).href) as Library
Object.assign(library.env,{allowRemoteModels:false,useFSCache:false,useBrowserCache:false})
const rows=(tensor:Tensor)=>Array.from({length:tensor.dims[0]!},(_,i)=>tensor.data.slice(i*384,(i+1)*384))
const cosine=(a:Float32Array,b:Float32Array)=>a.reduce((sum,x,i)=>sum+x*b[i]!,0)
const results:{dtype:'q8'|'fp32',id:string,mode:string,query:string,target:string,targetRank:number,targetScore:number,ranking:{id:string,score:number}[]}[]=[]
const outputs=new Map<string,{passages:Float32Array[],queries:Float32Array[]}>()
const official=[]
try{
 for(const dtype of ['q8','fp32'] as const){
  const extractor=await library.pipeline('feature-extraction',dtype==='q8'?q8Root:fp32Root,{dtype,device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:2,interOpNumThreads:1}})
  try{
   const passages:Float32Array[]=[]
   for(let i=0;i<short.length;i+=8){
    const prompts=short.slice(i,i+8).map(doc=>`passage: ${doc.body}`)
    assert.ok(prompts.every(text=>extractor.tokenizer.encode(text).length<=512))
    passages.push(...rows(await extractor(prompts,{pooling:'mean',normalize:true})))
   }
   const queries:Float32Array[]=[]
   for(const row of cases){
    const [vector]=rows(await extractor([`query: ${row.query}`],{pooling:'mean',normalize:true}));assert.ok(vector);queries.push(vector)
    const ranked=short.map((doc,i)=>({id:doc.id,score:cosine(vector,passages[i]!)})).sort((a,b)=>b.score-a.score)
    const targetRank=ranked.findIndex(item=>item.id===row.target)+1
    if(dtype==='q8') {assert.equal(targetRank,row.rawShortCorpus.rank);assert.ok(Math.abs(ranked[targetRank-1]!.score-row.rawShortCorpus.score)<0.000001)}
    results.push({dtype,id:row.id,mode:row.mode,query:row.query,target:row.target,targetRank,targetScore:ranked[targetRank-1]!.score,ranking:ranked})
   }
   outputs.set(dtype,{passages,queries})
   const sample=rows(await extractor(baselineInputs,{pooling:'mean',normalize:true}))
   official.push({dtype,tokenCounts:baselineInputs.map(text=>extractor.tokenizer.encode(text).length),scoresTimes100:[0,1].map(i=>[2,3].map(j=>cosine(sample[i]!,sample[j]!)*100)),matchingPassageRanks:[0,1].map(i=>[2,3].sort((a,b)=>cosine(sample[i]!,sample[b]!)-cosine(sample[i]!,sample[a]!)).indexOf(i+2)+1)})
  }finally{await extractor.dispose()}
 }
 const q8=outputs.get('q8')!,fp32=outputs.get('fp32')!
 const summary=cases.map((row,i)=>({id:row.id,mode:row.mode,q8Rank:results.find(r=>r.dtype==='q8'&&r.id===row.id&&r.mode===row.mode)!.targetRank,fp32Rank:results.find(r=>r.dtype==='fp32'&&r.id===row.id&&r.mode===row.mode)!.targetRank,queryVectorCosine:cosine(q8.queries[i]!,fp32.queries[i]!)}))
 const report={kind:'development-diagnosis',revision:'3acb1fa45c83e69002b1641b37f3cccc132cdd63',fp32Sha,q8Sha:hash(readFileSync(q8Root+'/onnx/model_quantized.onnx')),freeze,corpusSha:hash(JSON.stringify(short.map(({id,body})=>({id,body})))),corpusCount:short.length,batchSize:8,queryBatchSize:1,pooling:'attention-mask mean',normalize:'L2',runtime:'Transformers.js 4.3.2 ONNX CPU',officialModelCard:'https://huggingface.co/intfloat/multilingual-e5-small',officialCardSha:hash(card),officialSample:official,summary,results,limitations:['Raw-short-body-only diagnostic; not frozen validation acceptance.','FP32 ONNX export compared to q8 ONNX, not original PyTorch execution.','Official model-card examples have no published numeric expected matrix; check is matching-passage ordering only.','Second independent validation corpus remains unscored.']}
 writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({summary,official},null,2))
}finally{retrieval.close();db.close()}

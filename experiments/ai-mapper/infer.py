"""Experimental DriveDen SAM3 GeoTIFF to GeoJSON mapper. No production writes."""
import argparse
import json
from pathlib import Path

PROMPTS = {"green":"golf putting green", "tee":"golf tee box", "fairway":"golf fairway", "bunker":"golf sand bunker", "water":"water pond"}

def vectorize(mask, transform, crs, kind, score):
    import numpy as np
    from rasterio.features import shapes
    from rasterio.warp import transform_geom
    mask = np.asarray(mask, dtype=bool)
    features = []
    for geom, value in shapes(mask.astype("uint8"), mask=mask, transform=transform):
        if value != 1:
            continue
        g = transform_geom(crs, "EPSG:4326", geom)
        features.append({"type":"Feature","geometry":g,"properties":{"kind":kind,"confidence":float(score),"reviewRequired":True}})
    return features

def infer(path, source, threshold=0.5, model_id="facebook/sam3"):
    import rasterio
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam3Model, Sam3Processor
    from rasterio.windows import Window
    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required for this prototype.")
    model = Sam3Model.from_pretrained(model_id).to("cuda").eval()
    processor = Sam3Processor.from_pretrained(model_id)
    features = []
    with rasterio.open(path) as ds:
        if not ds.crs or ds.count < 3:
            raise ValueError("Input must be a georeferenced RGB GeoTIFF.")
        if any(t != "uint8" for t in ds.dtypes[:3]):
            raise ValueError("Convert imagery to 8-bit RGB before analysis.")
        for y in range(0, ds.height, 768):
            for x in range(0, ds.width, 768):
                window = Window(x,y,min(1024,ds.width-x),min(1024,ds.height-y))
                data = ds.read([1,2,3], window=window)
                if not data.size or not ds.dataset_mask(window=window).any():
                    continue
                image = Image.fromarray(np.moveaxis(data,0,-1))
                for kind,prompt in PROMPTS.items():
                    inputs = processor(images=image,text=prompt,return_tensors="pt").to("cuda")
                    with torch.inference_mode():
                        outputs = model(**inputs)
                    result = processor.post_process_instance_segmentation(outputs,threshold=threshold,mask_threshold=0.5,target_sizes=inputs["original_sizes"].tolist())[0]
                    for mask,score in zip(result["masks"],result["scores"]):
                        arr = mask.detach().cpu().numpy().squeeze() > 0.5
                        if arr.shape != data.shape[1:]:
                            raise ValueError("Mask shape does not match imagery.")
                        arr &= ds.dataset_mask(window=window)>0
                        features.extend(vectorize(arr,ds.window_transform(window),ds.crs,kind,score.item()))
    return {"type":"FeatureCollection","features":features,"provenance":{"source":source,"model":model_id,"reviewRequired":True,"tileOverlap":256,"duplicatesPossible":True}}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("image",type=Path)
    p.add_argument("output",type=Path)
    p.add_argument("--source",required=True,help="Imagery provider and applicable licence")
    p.add_argument("--rights-confirmed",action="store_true")
    p.add_argument("--threshold",type=float,default=0.5)
    a=p.parse_args()
    if not a.rights_confirmed:
        p.error("Confirm imagery rights for automated analysis and derived geometry first.")
    if not 0<a.threshold<1:
        p.error("Threshold must be between 0 and 1.")
    result=infer(a.image,a.source,a.threshold)
    a.output.write_text(json.dumps(result),encoding="utf-8")
    print(f"Exported {len(result['features'])} unreviewed features to {a.output}")

if __name__=="__main__":
    main()

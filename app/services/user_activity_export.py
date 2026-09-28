"""Streaming user activity exports to object storage."""

from __future__ import annotations

import csv
import io
import os
from collections.abc import AsyncIterable
from datetime import datetime, timezone
from typing import Any

import boto3


EXPORT_HEADERS = (
    "event_hash",
    "ledger_sequence",
    "tx_hash",
    "event_type",
    "created_at",
    "payload",
)
PART_SIZE_BYTES = 5 * 1024 * 1024


class S3CsvMultipartWriter:
    """File-like CSV sink that uploads completed multipart chunks to S3."""

    def __init__(self, client: Any, bucket: str, key: str) -> None:
        self._client = client
        self._bucket = bucket
        self._key = key
        self._buffer = bytearray()
        self._parts: list[dict[str, Any]] = []
        self._upload_id: str | None = None
        self._part_number = 1

    def start(self) -> None:
        response = self._client.create_multipart_upload(
            Bucket=self._bucket,
            Key=self._key,
            ContentType="text/csv; charset=utf-8",
            ContentDisposition="attachment",
        )
        self._upload_id = response["UploadId"]

    def write(self, value: str) -> int:
        self._buffer.extend(value.encode("utf-8"))
        while len(self._buffer) >= PART_SIZE_BYTES:
            self._upload_chunk(PART_SIZE_BYTES)
        return len(value)

    def finish(self) -> None:
        if self._buffer:
            self._upload_chunk(len(self._buffer))
        if not self._upload_id:
            raise RuntimeError("Multipart upload was not started")
        self._client.complete_multipart_upload(
            Bucket=self._bucket,
            Key=self._key,
            UploadId=self._upload_id,
            MultipartUpload={"Parts": self._parts},
        )

    def abort(self) -> None:
        if self._upload_id:
            self._client.abort_multipart_upload(
                Bucket=self._bucket,
                Key=self._key,
                UploadId=self._upload_id,
            )

    def _upload_chunk(self, size: int) -> None:
        if not self._upload_id:
            raise RuntimeError("Multipart upload was not started")
        chunk = bytes(self._buffer[:size])
        del self._buffer[:size]
        response = self._client.upload_part(
            Bucket=self._bucket,
            Key=self._key,
            UploadId=self._upload_id,
            PartNumber=self._part_number,
            Body=chunk,
        )
        self._parts.append(
            {"PartNumber": self._part_number, "ETag": response["ETag"]}
        )
        self._part_number += 1


def _config() -> tuple[str, str, int]:
    bucket = os.getenv("USER_ACTIVITY_EXPORT_BUCKET", os.getenv("S3_BUCKET", ""))
    if not bucket:
        raise RuntimeError("USER_ACTIVITY_EXPORT_BUCKET or S3_BUCKET must be configured")
    prefix = os.getenv("USER_ACTIVITY_EXPORT_PREFIX", "user-activity")
    try:
        expiry = int(os.getenv("USER_ACTIVITY_EXPORT_URL_TTL_SECONDS", "900"))
    except ValueError as exc:
        raise RuntimeError("USER_ACTIVITY_EXPORT_URL_TTL_SECONDS must be an integer") from exc
    if expiry < 1 or expiry > 604800:
        raise RuntimeError("USER_ACTIVITY_EXPORT_URL_TTL_SECONDS must be between 1 and 604800")
    return bucket, prefix.strip("/"), expiry


def _csv_row(row: Any) -> tuple[str, ...]:
    created_at = row["created_at"]
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()
    payload = row["payload"]
    return (
        str(row["event_hash"]),
        str(row["ledger_sequence"]),
        str(row["tx_hash"]),
        str(row["event_type"]),
        str(created_at),
        payload if isinstance(payload, str) else _json_value(payload),
    )


def _json_value(value: Any) -> str:
    import json

    return json.dumps(value, separators=(",", ":"), sort_keys=True)


async def export_user_activity(
    rows: AsyncIterable[Any], user_id: str, s3_client: Any | None = None
) -> dict[str, Any]:
    """Stream activity rows to S3 and return a short-lived download URL."""
    bucket, prefix, expiry = _config()
    client = s3_client or boto3.client("s3", region_name=os.getenv("AWS_REGION"))
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    key = f"{prefix}/{user_id}/activity-{timestamp}.csv"
    writer = S3CsvMultipartWriter(client, bucket, key)

    try:
        writer.start()
        text_stream = io.TextIOWrapper(_WriterAdapter(writer), encoding="utf-8")
        csv_writer = csv.writer(text_stream, lineterminator="\n")
        csv_writer.writerow(EXPORT_HEADERS)
        record_count = 0
        async for row in rows:
            csv_writer.writerow(_csv_row(row))
            record_count += 1
        text_stream.flush()
        writer.finish()
    except Exception:
        writer.abort()
        raise

    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expiry,
    )
    return {
        "bucket": bucket,
        "key": key,
        "record_count": record_count,
        "download_url": url,
        "expires_in_seconds": expiry,
    }


class _WriterAdapter(io.RawIOBase):
    def __init__(self, writer: S3CsvMultipartWriter) -> None:
        self._writer = writer

    def writable(self) -> bool:
        return True

    def write(self, value: bytes | bytearray) -> int:
        text = bytes(value).decode("utf-8")
        self._writer.write(text)
        return len(value)
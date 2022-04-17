#!/bin/bash
if [ $1 == "--cancel" ]
then
    . cancel.env
    yarn cancel
elif [ $1 == "--wash" ]
then
    . wash.env
    yarn wash
elif [ $1 == "--scan" ]
then
    . scan.env
    yarn scan
elif [ $1 == "--check-hit" ]
then
    . check-hit.env
    yarn check-hit
elif [ $1 == "--wick" ]
then
    . wick.env
    yarn wick
fi

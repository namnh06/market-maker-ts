#!/bin/bash
. .env

if [ $1 == "--cancel" ]
then
    yarn cancel
elif [ $1 == "--wash" ]
then
    yarn wash
elif [ $1 == "--scan" ]
then
    yarn scan
elif [ $1 == "--check-hit" ]
then
    yarn check-hit
elif [ $1 == "--wick" ]
then
    yarn wick
else
    yarn mm
fi
